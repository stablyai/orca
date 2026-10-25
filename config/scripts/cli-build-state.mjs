import { createHash } from 'node:crypto'
import {
  existsSync,
  globSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import lockfile from 'proper-lockfile'
import { describeProcessFailure } from './process-failure-message.mjs'

function digest(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function ownedPath(file) {
  return (
    typeof file === 'string' &&
    file !== '' &&
    !isAbsolute(file) &&
    !file.replaceAll('\\', '/').split('/').includes('..')
  )
}

function readState(file) {
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'))
    return state &&
      typeof state.outputs === 'object' &&
      state.outputs !== null &&
      !Array.isArray(state.outputs) &&
      Object.keys(state.outputs).length > 0 &&
      Object.entries(state.outputs).every(
        ([path, hash]) => ownedPath(path) && /^[a-f\d]{64}$/.test(hash)
      ) &&
      Array.isArray(state.sources) &&
      state.sources.length > 0 &&
      state.sources.every((source) => typeof source === 'string')
      ? state
      : null
  } catch {
    return null
  }
}

export async function runIncrementalCliBuild({ root, outDir, config, compiler, emitter, execute }) {
  root = realpathSync(root)
  const output = resolve(root, outDir)
  const key = createHash('sha256').update(output).digest('hex').slice(0, 16)
  const cache = join(root, '.cache', 'build', 'cli', compiler.version, key)
  mkdirSync(cache, { recursive: true })
  let compromised
  const release = await lockfile.lock(cache, {
    realpath: false,
    stale: 30_000,
    retries: { retries: 1_000, minTimeout: 50, maxTimeout: 250 },
    onCompromised: (error) => {
      compromised = error
    }
  })
  const assertLock = () => {
    if (compromised) {
      throw compromised
    }
  }
  const info = join(cache, 'cli.tsbuildinfo')
  const stateFile = join(cache, 'outputs.json')
  const pending = `${stateFile}.${process.pid}`
  try {
    const policy = [
      import.meta.filename,
      join(root, 'config', 'scripts', 'build-cli.mjs'),
      ...globSync('config/**/tsconfig*.json', { cwd: root }).map((file) => join(root, file)),
      ...['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].map((file) => join(root, file))
    ].filter(existsSync)
    const identity = createHash('sha256')
      .update(
        JSON.stringify([
          compiler,
          emitter,
          process.platform,
          process.arch,
          ...policy.sort().map((file) => [file, digest(file)])
        ])
      )
      .digest('hex')
    const previous = readState(stateFile)
    let cold = previous?.identity !== identity || !existsSync(info)
    try {
      cold ||=
        previous.sources.some((file) => !existsSync(file)) ||
        Object.entries(previous.outputs).some(([file, hash]) => digest(join(output, file)) !== hash)
      const buildInfo = JSON.parse(readFileSync(info, 'utf8'))
      const names = buildInfo.fileNames ?? buildInfo.program?.fileNames
      cold ||= !Array.isArray(names) || names.length === 0
    } catch {
      cold = true
    }
    if (cold) {
      rmSync(info, { force: true })
    }
    async function compile(command, args) {
      const result = await execute({
        program: command.program,
        args: [...command.args, ...args],
        cwd: root,
        maxOutputBytes: 64 * 1024 * 1024,
        timeoutMs: null
      })
      const stdout = result.stdout ?? ''
      const diagnostics = stdout
        .split(/\r?\n/)
        .filter((line) => !line.startsWith('TSFILE:'))
        .join('\n')
        .trim()
      if (diagnostics) {
        console.log(diagnostics)
      }
      if (result.stderr) {
        console.error(result.stderr.trimEnd())
      }
      if (result.code !== 0 || result.outputTruncated) {
        rmSync(info, { force: true })
        throw new Error(`CLI compilation failed: ${describeProcessFailure(result)}`)
      }
      assertLock()
      return stdout
    }
    await compile(compiler, [
      '-p',
      config,
      '--outDir',
      outDir,
      '--composite',
      'false',
      '--incremental',
      'true',
      '--tsBuildInfoFile',
      info,
      '--noEmit'
    ])
    const checked = digest(info)
    if (!cold && previous.checked === checked) {
      return
    }
    const stdout = await compile(emitter, [
      '-p',
      config,
      '--outDir',
      outDir,
      '--composite',
      'false',
      '--incremental',
      'false',
      '--noCheck',
      '--listEmittedFiles'
    ])
    const outputs = {}
    for (const match of stdout.matchAll(/^TSFILE: (.+)$/gm)) {
      const file = relative(output, resolve(root, match[1].trimEnd()))
      if (ownedPath(file)) {
        outputs[file] = digest(join(output, file))
      }
    }
    const buildInfo = JSON.parse(readFileSync(info, 'utf8'))
    const names = buildInfo.fileNames ?? buildInfo.program?.fileNames
    if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) {
      throw new Error('CLI incremental compiler did not provide its source inventory')
    }
    for (const file of Object.keys(previous?.outputs ?? {})) {
      if (!Object.hasOwn(outputs, file)) {
        assertLock()
        rmSync(join(output, file), { force: true })
      }
    }
    writeFileSync(
      pending,
      JSON.stringify({
        identity,
        checked,
        outputs,
        // tsrs embeds the standard libraries rather than loading them from disk.
        sources: names
          .filter((file) => !/^lib\.[\w.]+\.d\.ts$/.test(file))
          .map((file) => resolve(dirname(info), file))
      })
    )
    assertLock()
    renameSync(pending, stateFile)
  } finally {
    rmSync(pending, { force: true })
    if (!compromised) {
      await release()
    }
  }
}
