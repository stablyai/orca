import { parseExecutionHostId, type ExecutionHostId } from '../../../src/shared/execution-host'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ComponentProps } from 'react'
import type { PersistedTrustedOrcaHooks } from '../../../src/shared/orca-yaml-hook-types'
import type { SetupHookTrustDrawer, SetupTrustPrompt } from '../components/SetupHookTrustDrawer'
import { persistSetupHookTrustApproval } from '../tasks/setup-hook-trust'
import type { RpcClient } from '../transport/rpc-client'
import { prepareAutomationSetup } from './automation-setup-preparation'
import type { AutomationDraft } from './automation-draft'
import type { AutomationTargets } from './automation-target-inventory'

type Consent = {
  prompt: SetupTrustPrompt
  client: RpcClient
  executionHost?: ExecutionHostId
  trust: PersistedTrustedOrcaHooks
  current: () => boolean
  resolve: (decision: 'run' | 'skip' | null) => void
  reject: (failure: unknown) => void
}

export function useAutomationSetupConsent(
  client: RpcClient | null,
  executionHost?: ExecutionHostId
) {
  const authority = useRef({ client, executionHost })
  useLayoutEffect(() => {
    authority.current = { client, executionHost }
  }, [client, executionHost])
  const pending = useRef<Consent | null>(null)
  const approving = useRef(false)
  const [confirmation, setConfirmation] = useState<Pick<
    Consent,
    'prompt' | 'executionHost'
  > | null>(null)
  const [busy, setBusy] = useState(false)
  const finish = useCallback((decision: 'run' | 'skip' | null) => {
    const consent = pending.current
    pending.current = null
    setConfirmation(null)
    consent?.resolve(decision)
  }, [])
  useEffect(() => {
    const stop = client?.onStateChange(() => finish(null))
    return () => {
      stop?.()
      finish(null)
    }
  }, [client, executionHost, finish])
  async function approve(alwaysTrust: boolean) {
    const consent = pending.current
    if (!consent || approving.current) {
      return
    }
    if (!consent.current()) {
      return finish(null)
    }
    approving.current = true
    setBusy(true)
    try {
      if (parseExecutionHostId(consent.executionHost)?.kind !== 'runtime') {
        await persistSetupHookTrustApproval({
          client: consent.client,
          trust: consent.trust,
          repoId: consent.prompt.repoId,
          contentHash: consent.prompt.contentHash,
          alwaysTrust
        })
      }
      if (pending.current === consent) {
        finish(consent.current() ? 'run' : null)
      }
    } catch (failure) {
      if (pending.current === consent) {
        pending.current = null
        setConfirmation(null)
        consent.reject(failure)
      }
    } finally {
      approving.current = false
      setBusy(false)
    }
  }
  const drawer: ComponentProps<typeof SetupHookTrustDrawer> = {
    prompt: confirmation?.prompt ?? null,
    visible: confirmation !== null,
    allowAlwaysTrust: parseExecutionHostId(confirmation?.executionHost)?.kind !== 'runtime',
    busy,
    onRunOnce: () => void approve(false),
    onAlwaysTrust: () => void approve(true),
    onDontRun: () => {
      if (!approving.current) {
        finish('skip')
      }
    },
    onClose: () => {
      if (!approving.current) {
        finish(null)
      }
    }
  }
  return {
    drawer,
    prepare: (
      port: RpcClient,
      draft: AutomationDraft,
      targets: AutomationTargets,
      current: () => boolean,
      original?: AutomationDraft
    ) => {
      const sameAuthority = () =>
        current() &&
        authority.current.client === port &&
        authority.current.executionHost === executionHost
      return prepareAutomationSetup({
        client: port,
        executionHost,
        draft,
        original,
        targets,
        current: sameAuthority,
        confirm: (prompt, trust) =>
          new Promise((resolve, reject) => {
            if (!sameAuthority()) {
              return resolve(null)
            }
            pending.current = {
              prompt,
              trust,
              client: port,
              executionHost,
              current: sameAuthority,
              resolve,
              reject
            }
            setConfirmation({ prompt, executionHost })
          })
      })
    }
  }
}
