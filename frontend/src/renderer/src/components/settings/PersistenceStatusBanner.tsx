import { TriangleAlert } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type React from 'react'
import { useAppStore } from '@/store'
import type { ClientStateKind } from '@/runtime/runtime-client-state-client'
import { translate } from '@/i18n/i18n'

// FE-TASK-STORAGE-005 (CR-STORAGE-002): surfaces the persistenceStatus slice
// (FE-TASK-STORAGE-004) so a permanent backend-go write failure is visible
// instead of silently swallowed — see backend-go-storage.ts's
// withRetryAndErrorStatus doc comment for the retry/error-status contract
// this renders, and web-preload-api.ts's prior silent ui.set failure path
// this replaces for kinds that go through createBackendGoStorage.
const KIND_LABELS: Partial<Record<ClientStateKind, string>> = {
  keybindings: 'keyboard shortcuts',
  uiLocal: 'UI preferences',
  savedRuntimeEnvironments: 'saved servers',
  settings: 'settings',
  accountsDevServerMap: 'account dev-server picks'
}

function describeKind(kind: string): string {
  return KIND_LABELS[kind as ClientStateKind] ?? kind
}

export function PersistenceStatusBanner(): React.JSX.Element | null {
  const erroredKinds = useAppStore(
    useShallow((state) =>
      Object.entries(state.persistenceStatus)
        .filter(([, entry]) => entry?.status === 'error')
        .map(([kind]) => kind)
    )
  )

  if (erroredKinds.length === 0) {
    return null
  }

  const kindList = erroredKinds.map(describeKind).join(', ')

  return (
    // Why: role=alert — this fires asynchronously (a background retry finally
    // gave up), so screen readers must announce it unprompted, same reasoning
    // as ExternalFileChangeBanner's role=alert.
    <div
      role="alert"
      className="border-b border-destructive/20 bg-destructive/10 px-4 py-2 text-xs"
    >
      <div className="flex min-w-0 items-center gap-2">
        <TriangleAlert className="size-3.5 shrink-0 text-destructive" />
        <span className="min-w-0 font-medium text-foreground">
          {translate(
            'components.settings.PersistenceStatusBanner.failedToSync',
            'Some changes could not be saved to your account ({{kinds}}) and will keep retrying.',
            { kinds: kindList }
          )}
        </span>
      </div>
    </div>
  )
}
