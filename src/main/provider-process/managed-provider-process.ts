export type { ProviderProcessExit, ManagedProviderProcess } from './provider-process-close'
import { ProviderExternalTree } from './provider-external-tree'
import { spawnProcess } from '@orca/process-host'
import { RetryableProcessExitProof } from '@orca/process-host/retryable-process-exit-proof'
import type { ProviderProcessLaunch } from './provider-process-launch'
import { createProviderSpawnSpec } from './provider-process-launch'
import { PROVIDER_GROUP_REAP_TIMEOUT_MS } from './provider-process-timing'
import { recordProviderLaunch } from './provider-process-ledger'
import { writerVerdict, type ProviderResourceResult } from './provider-process-inventory'
import {
  observeProviderGroup,
  signalProviderGroup,
  stopRecordedProviderGroup
} from './provider-process-group'
import { retainCodexHomeWriter } from '../codex-cli/codex-home-process-lock'
import { ProviderCleanupBudget, waitForProcessExitUntil } from './provider-process-exit-deadline'
import {
  terminateProviderProcessTree,
  type ProviderProcessTeardownVerdict
} from './provider-process-teardown'
import type { DescendantTreeVerdict } from '../pty-descendant-exit-verification'
import { isMissingProviderExecutable } from './provider-executable-missing'
import {
  closeProviderProcess,
  rootOnlyProviderClosePolicy,
  type ProviderProcessCloseResult,
  type ManagedProviderProcessOptions,
  type ProviderProcessTree,
  type ProviderProcessExit,
  type ManagedProviderProcess
} from './provider-process-close'

import { observeProviderOutput } from './provider-process-output'

/** One child owns its exit observation and every retry of an unconfirmed close. */
export function spawnManagedProviderProcess(
  launch: ProviderProcessLaunch,
  options: ManagedProviderProcessOptions
): ManagedProviderProcess {
  const platform = options.platform ?? process.platform
  const closePolicy = options.policy ?? rootOnlyProviderClosePolicy
  const spec = createProviderSpawnSpec(launch, options.inheritedEnv ?? process.env, platform)
  const policy = closePolicy(platform !== 'win32')
  const child = (options.spawnImpl ?? spawnProcess)({
    ...spec,
    ...(platform === 'win32' && options.windowsDetached ? { detached: true } : {}),
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let groupRetired = false
  const group =
    platform !== 'win32' && child.pid !== undefined
      ? recordProviderLaunch(child.pid, options.resource)
      : undefined
  const listeners = new Set<(exit: ProviderProcessExit) => void>()
  let observed: ProviderProcessExit | null = null
  let spawnFailed = false
  let spawnError: unknown = null
  let lastCloseResult: ProviderProcessCloseResult | null = null
  const output = observeProviderOutput(child, options, () => {
    void group?.capture()
  })
  const drain = output.drain
  let resolveExit = (): void => {}
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve
  })
  const windowsExitProof = new RetryableProcessExitProof(
    options.acceptClose ?? ((result) => result.root === 'exited')
  )
  const groupProof = new RetryableProcessExitProof<ProviderProcessCloseResult>(
    (result) => result.tree === 'exited'
  )
  const external = new ProviderExternalTree()
  let naturalCleanup: Promise<DescendantTreeVerdict> | undefined
  let settled = false
  let resolveCompletion = (_exit: ProviderProcessExit): void => {}
  const completion = new Promise<ProviderProcessExit>((resolve) => {
    resolveCompletion = resolve
  })
  const reapExternal = (): Promise<DescendantTreeVerdict | null> => external.reap()
  const close = (
    tree?: ProviderProcessTree,
    budget?: ProviderCleanupBudget
  ): Promise<ProviderProcessCloseResult> => {
    if (tree) {
      external.current = tree
    }
    if (platform === 'win32' && observed && !tree) {
      const result: ProviderProcessCloseResult = { root: 'exited', tree: null }
      lastCloseResult ??= result
      return Promise.resolve(lastCloseResult.root === 'exited' ? lastCloseResult : result)
    }
    if (platform === 'win32') {
      return windowsExitProof.run(async () => {
        lastCloseResult = await closeProviderProcess({
          child,
          exitPromise,
          rootVerdict,
          policy,
          tree: external.current,
          terminateTree
        })
        return lastCloseResult
      })
    }
    const groupFlight = groupProof.run(async () => {
      if (!observed) {
        void group?.capture()
        await (budget
          ? budget.wait(external.current?.capture() ?? Promise.resolve(), undefined)
          : external.current?.capture())
        try {
          child.stdin.end()
        } catch {
          /* A broken pipe still owes cleanup. */
        }
        if (!policy.immediateTerm) {
          await waitForProcessExitUntil(
            exitPromise,
            Math.min(policy.gracefulExitMs, budget?.remaining() ?? Infinity)
          )
        }
        if (!observed) {
          void group?.capture()
        }
      }
      let verdict: DescendantTreeVerdict = 'exited'
      const pid = child.pid
      if (pid !== undefined && !observed?.processless && !groupRetired) {
        if (naturalCleanup) {
          verdict = await (budget
            ? budget.wait(naturalCleanup, 'unverifiable' as const)
            : naturalCleanup)
          naturalCleanup = undefined
        } else {
          await waitForProcessExitUntil(
            group?.capture(budget) ?? Promise.resolve(),
            Math.min(2_000, budget?.remaining() ?? Infinity)
          )
          verdict = await stopRecordedProviderGroup(
            pid,
            group?.members() ?? [],
            async () => !groupRetired,
            false,
            budget
          )
        }
      }
      await waitForProcessExitUntil(
        exitPromise,
        Math.min(PROVIDER_GROUP_REAP_TIMEOUT_MS, budget?.remaining() ?? Infinity)
      )
      if (verdict === 'exited') {
        groupRetired = true
        void group?.retire()
      }
      return { root: rootVerdict(), tree: verdict }
    })
    return (async () => {
      const result = await groupFlight
      if (observed) {
        await drain()
      }
      const external = await (budget ? budget.wait(reapExternal(), null) : reapExternal())
      lastCloseResult =
        external === null
          ? { ...result, root: rootVerdict() }
          : {
              ...result,
              root: rootVerdict(),
              tree:
                result.tree === 'exited'
                  ? external
                  : external === 'exited'
                    ? result.tree
                    : result.tree === 'live' || external === 'live'
                      ? 'live'
                      : 'unverifiable'
            }
      return lastCloseResult
    })()
  }
  const observeExit = (exit: ProviderProcessExit): void => {
    if (observed) {
      return
    }
    observed = exit
    if (platform !== 'win32' && child.pid !== undefined && !exit.processless && !groupRetired) {
      // Immediate root-exit cleanup is part of this launch, never replayed by a later close.
      signalProviderGroup(child.pid, 'SIGKILL')
      naturalCleanup = observeProviderGroup(child.pid, PROVIDER_GROUP_REAP_TIMEOUT_MS)
    }
    resolveExit()
    for (const listener of listeners) {
      listener(exit)
    }
    listeners.clear()
    void drain()
    void (async () => {
      try {
        await close()
        await drain()
        if (platform !== 'win32') {
          await reapExternal()
        }
      } catch {
        // Failed cleanup still settles the physical exit; writer proof stays separate.
      } finally {
        settled = true
        resolveCompletion(exit)
      }
    })()
  }
  child.on('exit', (code, signal) => observeExit({ code, signal, processless: false }))
  child.on('error', (error) => {
    spawnFailed ||= child.pid === undefined
    spawnError ??= error
  })
  child.on('close', (code, signal) => {
    const processless = spawnFailed && child.pid === undefined
    if (processless) {
      observeExit({ code, signal, processless })
    }
  })
  const rootVerdict = (): DescendantTreeVerdict =>
    observed ? 'exited' : child.pid === undefined ? 'unverifiable' : 'live'
  const terminateTree = (): Promise<ProviderProcessTeardownVerdict> =>
    terminateProviderProcessTree(child, { site: options.site, platform })

  const managed: ManagedProviderProcess = {
    child,
    dedicatedGroup: platform !== 'win32',
    exitPromise,
    completion,
    get settled() {
      return settled
    },
    onSettled(listener) {
      void completion.then(listener)
    },
    async verifyWriters(budget) {
      if (!child.pid) {
        return observed?.processless ? 'released' : 'unknown'
      }
      if (platform === 'win32') {
        return rootVerdict() === 'exited' ? 'released' : 'live'
      }
      if (budget && (!observed || !groupRetired || external.owed)) {
        const cleanup = async (): Promise<void> => {
          await close(undefined, budget)
        }
        await budget.wait(group?.cleanup ? group.cleanup(budget, cleanup) : cleanup(), undefined)
      }
      if (!observed) {
        return 'live'
      }
      return verifyProviderWriters(group, budget)
    },
    get processless() {
      return observed?.processless ?? false
    },
    get rootVerdict() {
      return rootVerdict()
    },
    get rootExitObserved() {
      return observed !== null && !observed.processless
    },
    get executableMissing() {
      return isMissingProviderExecutable(spawnError, launch.command)
    },
    stderrTail: output.stderrTail,
    get lastCloseResult() {
      return lastCloseResult
    },
    onExit(listener) {
      if (observed) {
        listener(observed)
      } else {
        listeners.add(listener)
      }
    },
    terminateTree,
    attachTree(tree) {
      external.current = tree
      if (observed && platform !== 'win32') {
        void reapExternal().catch(() => {})
      }
    },
    close
  }
  if (options.resource) {
    retainCodexHomeWriter(options.resource.key, managed.verifyWriters)
  }
  return managed
}

/** Resource proof follows captured incarnations, including those that changed groups. */
async function verifyProviderWriters(
  record: ReturnType<typeof recordProviderLaunch> | undefined,
  budget = new ProviderCleanupBudget(Date.now() + 2_000)
): Promise<ProviderResourceResult> {
  if (record?.verifyResource) {
    return budget.wait(record.verifyResource(budget), 'unknown')
  }
  const verdict = await budget.wait(writerVerdict(record?.members() ?? [], budget), 'unknown')
  return !budget.active ? 'unknown' : verdict === 'exited' ? 'released' : verdict
}
