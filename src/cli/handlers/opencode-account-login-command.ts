import type { ChildProcessHandle } from '@orca/process-host/process-spec'
import { spawnProcess } from '@orca/process-host'
import {
  forceTerminateProcessTree,
  signalProcessTree
} from '@orca/process-host/process-tree-termination'
import { inFlightWindowsTreeKill } from '@orca/process-host/windows-tree-kill'
import { createOutputSink } from '@orca/process-host/bounded-output-sink'
import { resolveCliCommand, withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import {
  getSpawnArgsForWindows,
  UnsafeWindowsBatchArgumentsError,
  WINDOWS_BATCH_UNSAFE_CHARACTERS_LABEL
} from '../../shared/windows-batch-spawn'
import { RuntimeClientError } from '../runtime-client'
import {
  type InteractiveLoginSession,
  LOGIN_PROCESS_POSIX_GRACE_MS,
  LOGIN_PROCESS_CLOSE_FALLBACK_MS
} from './interactive-login-interruption'

export async function resolveOpenCodeLoginCommand(
  env: NodeJS.ProcessEnv,
  session: InteractiveLoginSession
): Promise<string> {
  const unsafeLauncherPaths: string[] = []
  for (const command of ['opencode2', 'opencode']) {
    try {
      const resolvedCommand = resolveCliCommand(command)
      let prepared: ReturnType<typeof getSpawnArgsForWindows>
      try {
        prepared = getSpawnArgsForWindows(resolvedCommand, ['auth', 'login', '--help'])
      } catch (error) {
        if (error instanceof UnsafeWindowsBatchArgumentsError) {
          unsafeLauncherPaths.push(resolvedCommand)
        }
        throw error
      }
      const { spawnCmd, spawnArgs } = prepared
      if (
        await probeStandaloneLogin(
          spawnCmd,
          spawnArgs,
          withCliRuntimeOnPath(resolvedCommand, env),
          session
        )
      ) {
        return command
      }
    } catch (error) {
      if (session.terminationPromise) {
        throw error
      }
      // A missing or unusable candidate does not rule out the other installed binary.
    }
  }
  const preparationDiagnosis = unsafeLauncherPaths.length
    ? ` Windows could not start the OpenCode batch launchers from these paths: ${unsafeLauncherPaths.map((path) => `\`${path}\``).join(', ')}.`
    : ''
  const installGuidance =
    process.platform === 'win32'
      ? `Choose a separate prefix with a full absolute path without ${WINDOWS_BATCH_UNSAFE_CHARACTERS_LABEL} or line breaks, for example \`npm install --prefix C:\\tools\\orca-opencode2 @opencode/cli\`. If an existing unusable opencode2 is the first match, repair/relocate that installation or move/rename only its suffixed opencode2 launchers out of command lookup, including any further earlier matches. Leave the existing generic opencode launcher and shared npm PATH directories unchanged. Then append C:\\tools\\orca-opencode2\\node_modules\\.bin (or your safe prefix's node_modules\\.bin) to PATH after existing entries, so the first opencode2 match is the safe installation, and run this command again.`
      : 'Install alongside your existing CLI with `npm install --prefix ./orca-opencode2 @opencode/cli`. Append the absolute path of orca-opencode2/node_modules/.bin to PATH after existing entries, then run this command again.'
  throw new RuntimeClientError(
    'invalid_environment',
    `Could not find an OpenCode 2 login. Managed OpenCode accounts require OpenCode 2.${preparationDiagnosis} ${installGuidance}`
  )
}

async function probeStandaloneLogin(
  program: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  session: InteractiveLoginSession
): Promise<boolean> {
  const child = spawnProcess({ program, args, env, detached: process.platform !== 'win32' })
  const output = createOutputSink(64 * 1024)
  let result: { code: number | null } | undefined
  let closed = false
  let failed = false
  let timedOut = false
  let stopPromise: Promise<void> | undefined
  let drainTimer: ReturnType<typeof setTimeout> | undefined
  let complete!: () => void
  let close!: () => void
  let exited!: () => void
  let released!: () => void
  const completion = new Promise<void>((resolve) => {
    complete = resolve
  })
  const closing = new Promise<void>((resolve) => {
    close = resolve
  })
  const exiting = new Promise<void>((resolve) => {
    exited = resolve
  })
  const release = new Promise<void>((resolve) => {
    released = resolve
  })
  const stopOutput = (): void => {
    for (const stream of [child.stdout, child.stderr]) {
      stream?.off('data', output.write)
      stream?.resume()
    }
    complete()
  }
  const onParentExit = (): void => {
    void signalProcessTree(child, 'SIGKILL')
  }
  const onSpawn = (): void => {
    if (process.platform !== 'win32') {
      process.once('exit', onParentExit)
    }
  }
  const onExit = (code: number | null): void => {
    result = { code }
    exited()
    clearTimeout(executionTimer)
    process.off('exit', onParentExit)
    // One deadline drains both pipes, independently of the execution deadline.
    drainTimer = setTimeout(stopOutput, 1_000)
  }
  const onClose = (code: number | null): void => {
    closed = true
    if (!result) {
      onExit(code)
    }
    clearTimeout(drainTimer)
    close()
    complete()
  }
  const onError = (): void => {
    failed = true
    complete()
  }
  const ignoreStreamError = (): void => {}
  const stop = (signal: NodeJS.Signals): Promise<void> =>
    (stopPromise ??= (async () => {
      const signaled = await signalProcessTree(child, signal).catch(() => false)
      if (process.platform === 'win32') {
        // The caller's five-second wait is shorter than the tracked taskkill lifetime.
        await inFlightWindowsTreeKill(child)
      } else {
        if (!signaled) {
          killProbeRoot(child, signal)
        }
        if (!(await waitForProbe(closing, LOGIN_PROCESS_POSIX_GRACE_MS))) {
          await forceTerminateProcessTree(child).catch(() => false)
        }
      }
      if (!result) {
        killProbeRoot(child, process.platform === 'win32' ? undefined : 'SIGKILL')
      }
      await waitForProbe(exiting, LOGIN_PROCESS_CLOSE_FALLBACK_MS)
      complete()
    })())
  const stopPhase = (signal: NodeJS.Signals): Promise<void> => {
    void stop(signal)
    return release
  }
  const executionTimer = setTimeout(() => {
    timedOut = true
    void stop('SIGTERM')
  }, 10_000)
  session.child = child
  session.stopPhase = stopPhase
  child.on('spawn', onSpawn)
  child.on('error', onError)
  child.once('exit', onExit)
  child.once('close', onClose)
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    stream?.on('error', ignoreStreamError)
  }
  child.stdout?.on('data', output.write)
  child.stderr?.on('data', output.write)
  try {
    child.stdin?.end()
    await completion
  } finally {
    clearTimeout(executionTimer)
    try {
      // A drain finishing during stop must not erase the owned escalation obligation.
      if (stopPromise) {
        await stopPromise
      } else if (child.pid && (!result || (result.code !== null && result.code !== 0))) {
        await stop('SIGTERM')
      }
    } finally {
      clearTimeout(drainTimer)
      process.off('exit', onParentExit)
      child.off('spawn', onSpawn)
      child.off('error', onError)
      if (!closed) {
        child.on('error', ignoreStreamError)
        child.once('close', () => child.off('error', ignoreStreamError))
      }
      child.off('exit', onExit)
      child.off('close', onClose)
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        stream?.off('data', output.write)
        stream?.destroy()
        // Destruction can emit a deferred error after the scope has returned.
        if (stream?.closed) {
          stream.off('error', ignoreStreamError)
        } else {
          stream?.once('close', () => stream.off('error', ignoreStreamError))
        }
      }
      if (session.child === child) {
        session.child = null
      }
      if (session.stopPhase === stopPhase) {
        session.stopPhase = undefined
      }
      released()
    }
  }
  if (session.terminationPromise) {
    throw new RuntimeClientError('internal', 'OpenCode sign-in was interrupted.')
  }
  return !failed && !timedOut && result?.code === 0 && /--standalone\b/.test(output.text())
}

async function waitForProbe(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

function killProbeRoot(child: ChildProcessHandle, signal?: NodeJS.Signals): void {
  try {
    child.kill(signal)
  } catch {
    /* already gone */
  }
}
