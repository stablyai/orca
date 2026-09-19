/**
 * The goldens recorded at a call site inside the C1 page closure, and what each one did at the
 * bridge.
 *
 * C1 moves a screen to the web: `app/h/_layout.tsx` and `app/h/[hostId]/index.tsx` and everything
 * they import. The suite next door already proves the corpus replays byte-identically or in a named
 * class, but it proves it as counts over 787 goldens, and a count is the wrong instrument for the
 * claim C1 needs. These 103 are the ones whose divergence would be this domain's divergence, so
 * each is pinned by id to the verdict it gives, not counted into a total another golden can pay for.
 *
 * The rule is not "none excluded". 54 replay byte for byte and 49 do not, in four of the five
 * classes the suite next door names — 37 `result-absent-settlement`, 7 `params-undefined`, 3
 * `result-absent-stream-release`, 2 `write-ordinal`. Every one is a recorder observation artifact
 * whose wire bytes C0.5 and C0.8 proved identical: what differs is the shape the recorder injects
 * below the frame boundary, or the pre-serialization object a step is matched against, and neither
 * is something a transport carries. What the pin buys is that the 49 are named. A fiftieth arriving
 * is a red test here even though every count in `BRIDGED_PARITY_BASELINE` still holds, because the
 * class it joined has room in its bound for a golden that left.
 *
 * Derived from the value-import closure of the two route modules with `.web.*` resolution applied,
 * against the module each operation's mount adapter loads. `mobileWeb.bundle-manifest` is not here:
 * it reaches the closure only through the shared `rpc-operation.ts` runner, and its own operation
 * module is the shell's, not the page's.
 */

import type { BridgedParityClass } from './divergence-classes'

/** Byte-identical, or the class that named the divergence. */
export type BridgedParityVerdict = BridgedParityClass | 'identical'

export type C1PageClosureObservation = {
  family: string
  verdict: BridgedParityVerdict
}

export const C1_PAGE_CLOSURE: Readonly<
  Record<string, Readonly<Record<string, BridgedParityVerdict>>>
> = {
  'settings.repo-metadata': {
    'matrix-settings.repo-metadata-host.platform-1': 'result-absent-settlement',
    'matrix-settings.repo-metadata-repo.list-1': 'result-absent-settlement',
    'matrix-settings.repo-metadata-settings.get-1': 'result-absent-settlement',
    'matrix-settings.repo-metadata-ssh.listtargetsummaries-1': 'result-absent-settlement',
    'schedules-settings-repo-metadata-fulfilled': 'identical',
    'settings-repo-cache-expiry': 'identical',
    'settings-repo-metadata-fulfilled': 'identical',
    'settings-repo-metadata-icons': 'identical',
    'settings-repo-metadata-refuse-after-data': 'identical',
    'settings-repo-metadata-refused': 'identical',
    'settings-repo-metadata-single-host': 'identical',
    'settings-repo-metadata-transport-error': 'identical'
  },
  'settings.workspace-context': {
    'lifecycle-settings-workspace-context-fulfilled': 'identical',
    'matrix-settings.workspace-context-linear.status-1': 'result-absent-settlement',
    'matrix-settings.workspace-context-preflight.check-1': 'result-absent-settlement',
    'matrix-settings.workspace-context-settings.get-1': 'result-absent-settlement',
    'matrix-settings.workspace-context-ui.get-1': 'result-absent-settlement',
    'schedules-settings-workspace-context-fulfilled': 'identical',
    'settings-workspace-context-fulfilled': 'identical',
    'settings-workspace-context-refuse-after-data': 'identical',
    'settings-workspace-context-refused': 'identical',
    'settings-workspace-context-transport-error': 'identical'
  },
  'tasks.smart-source-search': {
    'matrix-tasks.smart-source-search-github.listworkitems-1': 'params-undefined',
    'matrix-tasks.smart-source-search-gitlab.listworkitems-1': 'params-undefined',
    'matrix-tasks.smart-source-search-linear.listissues-1': 'params-undefined',
    'matrix-tasks.smart-source-search-linear.searchissues-1': 'params-undefined',
    'matrix-tasks.smart-source-search-repo.searchrefs-1': 'params-undefined',
    'tw-smart-search-all-providers': 'params-undefined',
    'tw-smart-search-gitlab-provider-error': 'identical',
    'tw-smart-search-linear-listed': 'params-undefined'
  },
  'worktree.create-retry': {
    'matrix-worktree.create-retry-worktree.create-1': 'result-absent-settlement',
    'tw-create-retry-ambiguous-after-drop': 'identical',
    'tw-create-retry-ambiguous-while-connected': 'identical',
    'tw-create-retry-ambiguous-without-idempotency': 'identical',
    'tw-create-retry-created': 'identical',
    'tw-create-retry-name-collision': 'identical',
    'tw-create-retry-unretryable-refusal': 'identical',
    'tw-create-retry-warning-kept': 'identical'
  },
  'tasks.paste-lookup': {
    'matrix-tasks.paste-lookup-github.reposlug-1': 'result-absent-settlement',
    'matrix-tasks.paste-lookup-github.workitem-1': 'result-absent-settlement',
    'matrix-tasks.paste-lookup-github.workitembyownerrepo-1': 'result-absent-settlement',
    'matrix-tasks.paste-lookup-gitlab.workitembypath-1': 'result-absent-settlement',
    'tw-paste-lookup-resolved': 'identical',
    'tw-paste-lookup-slug-refused': 'identical',
    'tw-paste-lookup-slug-unsupported': 'identical'
  },
  'host-worktree-refresh': {
    'host-worktree-refresh-stream': 'write-ordinal',
    'matrix-host-worktree-refresh-runtime.clientevents.subscribe-1-1':
      'result-absent-stream-release',
    'matrix-host-worktree-refresh-runtime.clientevents.subscribe-1-2':
      'result-absent-stream-release',
    'matrix-host-worktree-refresh-runtime.clientevents.subscribe-1-3':
      'result-absent-stream-release',
    'matrix-host-worktree-refresh-runtime.clientevents.subscribe-2-1': 'write-ordinal'
  },
  'host.worktree-actions': {
    'host-worktree-actions-pin-open-delete': 'identical',
    'host-worktree-delete-refused': 'identical',
    'matrix-host.worktree-actions-worktree.activate-1': 'result-absent-settlement',
    'matrix-host.worktree-actions-worktree.rm-1': 'result-absent-settlement',
    'matrix-host.worktree-actions-worktree.set-1': 'result-absent-settlement'
  },
  'transport.capability-probe': {
    'matrix-transport.capability-probe-status.get-1': 'result-absent-settlement',
    'transport-capability-probe-cutover-reasks-fast': 'identical',
    'transport-capability-probe-non-string-capabilities-drop': 'identical',
    'transport-capability-probe-publishes': 'identical',
    'transport-capability-probe-refused-backs-off': 'identical'
  },
  'components.execution-target': {
    'components-target-ssh': 'identical',
    'matrix-components.execution-target-preflight.detectremoteagents-1': 'result-absent-settlement',
    'matrix-components.execution-target-ssh.connect-1': 'result-absent-settlement',
    'matrix-components.execution-target-ssh.getstate-1': 'result-absent-settlement'
  },
  'notifications.push-registration': {
    'matrix-notifications.push-registration-notifications.registerpush-1':
      'result-absent-settlement',
    'matrix-notifications.push-registration-notifications.unregisterpush-1':
      'result-absent-settlement',
    'notifications-push-gateway-rejected': 'identical',
    'notifications-push-registered': 'identical'
  },
  'settings.workspace-submit': {
    'matrix-settings.workspace-submit-settings.get-1': 'result-absent-settlement',
    'settings-workspace-submit-fulfilled': 'identical',
    'settings-workspace-submit-refused': 'identical',
    'settings-workspace-submit-transport-error': 'identical'
  },
  'transport.host-status-gates': {
    'matrix-transport.host-status-gates-status.get-1': 'result-absent-settlement',
    'transport-host-status-gates-drop-keeps-capabilities': 'identical',
    'transport-host-status-gates-ready': 'identical',
    'transport-host-status-gates-refused-degrades': 'identical'
  },
  'worktree.hosted-base': {
    'matrix-worktree.hosted-base-worktree.resolvemrbase-1': 'result-absent-settlement',
    'matrix-worktree.hosted-base-worktree.resolveprbase-1': 'result-absent-settlement',
    'tw-hosted-base-resolved': 'identical',
    'tw-hosted-base-soft-error': 'identical'
  },
  'worktree.runtime-capabilities': {
    'matrix-worktree.runtime-capabilities-status.get-1': 'result-absent-settlement',
    'tw-capabilities-advertised': 'identical',
    'tw-capabilities-cutover-retried': 'identical',
    'tw-capabilities-legacy-idempotency': 'identical'
  },
  'host.view-settings': {
    'host-view-settings-sync': 'identical',
    'matrix-host.view-settings-ui.get-1': 'result-absent-settlement',
    'matrix-host.view-settings-ui.set-1': 'result-absent-settlement'
  },
  'worktree.catalog-snapshot': {
    'matrix-worktree.catalog-snapshot-worktree.ps-1': 'result-absent-settlement',
    'worktree-catalog-snapshot': 'identical',
    'worktree-catalog-snapshot-unreadable': 'result-absent-settlement'
  },
  'worktree.setup-hook-trust': {
    'matrix-worktree.setup-hook-trust-ui.set-1': 'result-absent-settlement',
    'tw-setup-hook-trust-always': 'identical',
    'tw-setup-hook-trust-approved': 'identical'
  },
  'components.execution-target-local': {
    'components-target-local': 'identical',
    'matrix-components.execution-target-local-preflight.detectagents-1': 'result-absent-settlement'
  },
  'components.new-workspace-repositories': {
    'matrix-components.new-workspace-repositories-repo.list-1': 'result-absent-settlement',
    'new-workspace-repositories-fulfilled': 'identical'
  },
  'components.setup-script': {
    'components-setup-ask': 'identical',
    'matrix-components.setup-script-repo.hooks-1': 'result-absent-settlement'
  },
  'worktree.agent-launch-create': {
    'matrix-worktree.agent-launch-create-agent.launch-1': 'result-absent-settlement',
    'tw-create-retry-agent-launched': 'identical'
  },
  'worktree.retired-names': {
    'matrix-worktree.retired-names-worktree.listretirednames-1': 'result-absent-settlement',
    'worktree-retired-names': 'identical'
  }
}

/** Every closure golden that did not replay byte-identically, which the suite prints beside why. */
export function c1PageClosureExclusions(): readonly (readonly [string, BridgedParityClass])[] {
  return Object.values(C1_PAGE_CLOSURE).flatMap((family) =>
    Object.entries(family).flatMap(([id, verdict]) =>
      verdict === 'identical' ? [] : [[id, verdict] as const]
    )
  )
}

/**
 * Each closure family whose goldens or verdicts are not the ones pinned above, said in one line.
 *
 * Membership is checked per family rather than against the flat id list, so a golden newly derived
 * into a family this domain owns arrives as a finding instead of going unnoticed for being absent
 * from a pin that never mentioned it.
 */
export function c1PageClosureDrift(
  observed: ReadonlyMap<string, C1PageClosureObservation>
): readonly string[] {
  const byFamily = new Map<string, string[]>()
  for (const [id, { family }] of observed) {
    byFamily.set(family, [...(byFamily.get(family) ?? []), id])
  }
  const drift: string[] = []
  for (const [family, pinned] of Object.entries(C1_PAGE_CLOSURE)) {
    const seen = byFamily.get(family) ?? []
    const arrived = seen.filter((id) => !(id in pinned))
    const left = Object.keys(pinned).filter((id) => !seen.includes(id))
    if (arrived.length > 0 || left.length > 0) {
      drift.push(
        `${family}: arrived ${arrived.join(', ') || '(none)'}; left ${left.join(', ') || '(none)'}`
      )
    }
    for (const [id, verdict] of Object.entries(pinned)) {
      const ran = observed.get(id)?.verdict
      if (ran !== undefined && ran !== verdict) {
        drift.push(`${id}: pinned ${verdict}, ran ${ran}`)
      }
    }
  }
  return drift
}
