import assert from 'node:assert/strict'
import { once } from 'node:events'
import { spawnProcess } from '../../src/shared/child-process/run-process'
import { SshChannelMultiplexer } from '../../src/main/ssh/ssh-channel-multiplexer'
import { SshFilesystemProvider } from '../../src/main/providers/ssh-filesystem-provider'
import { SshGitProvider } from '../../src/main/providers/ssh-git-provider'
import { RELAY_SENTINEL } from '../../src/main/ssh/relay-protocol'

async function main(): Promise<void> {
  const [host, root] = process.argv.slice(2)
  assert.match(root, /^\/tmp\/orca-cow-rpc\.[A-Za-z0-9]+$/)
  const child = spawnProcess({
    program: 'ssh',
    args: [
      '-o',
      'BatchMode=yes',
      host,
      `ORCA_BACKGROUND_LAUNCH=1 HOME=${root} ORCA_USER_DATA_PATH=${root} exec /usr/local/bin/node ${root}/relay.js --sock-path ${root}/relay.sock --grace-time 1`
    ]
  })
  const closed = once(child, 'close')
  let stderr = ''
  child.stderr!.on('data', (data: Buffer) => {
    stderr = (stderr + data.toString()).slice(-16000)
  })
  const dataListeners: ((data: Buffer) => void)[] = []
  const closeListeners: (() => void)[] = []
  let pending = Buffer.alloc(0)
  let ready = false
  const started = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Relay startup timed out: ${stderr}`)), 15000)
    child.once('close', () => {
      clearTimeout(timer)
      if (!ready) {
        reject(new Error(`Relay exited: ${stderr}`))
      }
      closeListeners.forEach((cb) => cb())
    })
    child.stdout!.on('data', (data: Buffer) => {
      if (ready) {
        dataListeners.forEach((cb) => cb(data))
        return
      }
      pending = Buffer.concat([pending, data])
      const index = pending.indexOf(RELAY_SENTINEL)
      if (index === -1) {
        return
      }
      ready = true
      clearTimeout(timer)
      const rest = pending.subarray(index + Buffer.byteLength(RELAY_SENTINEL))
      resolve()
      setImmediate(() => {
        if (rest.length) {
          dataListeners.forEach((cb) => cb(rest))
        }
      })
    })
  })
  let mux: SshChannelMultiplexer | undefined
  try {
    await started
    mux = new SshChannelMultiplexer({
      write: (data) => {
        child.stdin!.write(data)
      },
      onData: (cb) => {
        dataListeners.push(cb)
      },
      onClose: (cb) => {
        closeListeners.push(cb)
      }
    })
    const fs = new SshFilesystemProvider('cow-exercise', mux)
    const git = new SshGitProvider('cow-exercise', mux)
    const source = `${root}/source`,
      target = `${root}/target`
    const status = (await mux.request('relay.status', {})) as { pid: number }
    const materialized = await fs.materializeWorktreePaths(source, target, [])
    assert.equal(materialized.supported, true)
    assert.equal(materialized.warning, undefined)
    assert.equal((await fs.readFile(`${target}/.env`)).content, 'original')
    await fs.writeFile(`${target}/.env`, 'private')
    assert.equal((await fs.readFile(`${source}/.env`)).content, 'original')
    await fs.writeFile(`${target}/cache/alias`, 'private alias edit')
    assert.equal((await fs.readFile(`${source}/cache/value`)).content, 'original alias')
    await fs.writeFile(`${target}/deps/value`, 'shared edit')
    assert.equal((await fs.readFile(`${source}/deps/value`)).content, 'shared edit')
    const sharedLinks = { source, paths: [] }
    assert.equal((await git.worktreeIsClean(target)).clean, false)
    assert.equal((await git.worktreeIsClean(target, { sharedLinks })).clean, true)
    await git.removeWorktree(target, false, { sharedLinks, deleteBranch: false })
    await assert.rejects(fs.stat(target))
    assert.equal((await fs.readFile(`${source}/deps/value`)).content, 'shared edit')
    console.log(
      JSON.stringify({
        host,
        pid: status.pid,
        supported: true,
        privateCopies: true,
        sharedLinks: true,
        cleanRemoval: true,
        passed: true
      })
    )
  } finally {
    mux?.dispose()
    child.stdin!.end()
    const timer = setTimeout(() => child.kill(), 10000)
    const [code] = await closed
    clearTimeout(timer)
    assert.equal(code, 0, `Relay transport did not exit cleanly: ${stderr}`)
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
