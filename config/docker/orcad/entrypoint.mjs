import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnProcess } from '@orca/process-host'

async function main() {
  process.umask(0o077)
  const state = process.env.ORCA_USER_DATA
  if (process.getuid?.() === 0 || !state || !process.env.HOME) {
    throw new Error('orcad requires a nonroot user, HOME and ORCA_USER_DATA')
  }
  for (const path of [state, process.env.HOME, '/run/orca', '/workspaces']) {
    await mkdir(path, { recursive: true })
  }
  try {
    await writeFile(resolve(state, 'machine-id'), `${randomBytes(16).toString('hex')}\n`, {
      flag: 'wx',
      mode: 0o600
    })
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error
    }
  }
  if (!/^[a-f0-9]{32}\n?$/.test(await readFile('/etc/machine-id', 'utf8'))) {
    throw new Error('persistent /etc/machine-id is invalid')
  }
  const readinessPath = '/run/orca/readiness.json'
  await rm(readinessPath, { force: true })
  const marker = (await readFile('/opt/orca/orcad/.runtime-node', 'utf8')).trim()
  const node = `/opt/orca/runtimes/node-${marker}/bin/node`
  const child = spawnProcess({
    program: node,
    args: [
      '/opt/orca/orcad/orcad.js',
      '--bind',
      '0.0.0.0',
      '--port',
      '6768',
      '--json',
      '--pairing-address',
      process.env.ORCAD_PAIRING_ADDRESS || '127.0.0.1:6768'
    ],
    cwd: '/workspaces',
    env: process.env,
    timeoutMs: null
  })
  child.stderr.pipe(process.stderr)
  let line = ''
  let published = Promise.resolve()
  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk)
    line += chunk.toString('utf8')
    let newline
    while ((newline = line.indexOf('\n')) !== -1) {
      const candidate = line.slice(0, newline)
      line = line.slice(newline + 1)
      if (!candidate.startsWith('{')) {
        continue
      }
      try {
        const ready = JSON.parse(candidate)
        if (ready.type === 'orca_server_ready') {
          published = writeFile(`${readinessPath}.tmp`, `${candidate}\n`, { mode: 0o600 })
            .then(() => rename(`${readinessPath}.tmp`, readinessPath))
            .catch((error) => {
              console.error(error)
              child.kill('SIGTERM')
            })
        }
      } catch {
        /* Non-readiness output passes through to the operator. */
      }
    }
    if (line.length > 1024 * 1024) {
      line = ''
    }
  })
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => child.kill(signal))
  }
  const exit = await new Promise((done) => {
    child.once('error', (error) => {
      console.error(error)
      done(1)
    })
    child.once('exit', (code, signal) => done(code ?? (signal ? 1 : 0)))
  })
  await published
  await rm(readinessPath, { force: true })
  process.exitCode = exit
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
