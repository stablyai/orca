// A page a paired computer hosts for this runtime, as its registry records it.
import type { RuntimeBrowserClientPlacement } from '../../../../shared/browser/client-hosting/runtime-browser-placement'
import type { TeammateTabListKey } from '../../../bots/team-share/teammate-rules'

export type RuntimeBrowserClientPage = Readonly<{
  browserPageId: string
  workspaceId: string
  browserProfileId: string
  executionHostKey: string
  placement: RuntimeBrowserClientPlacement
  /** Retain paired-device identity after lease loss so returning hosts can authenticate page recovery. */
  pairedDeviceId?: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** Remote-safe icon the hosting desktop reported; null until it reports one. */
  faviconUrl?: string | null
  active: boolean
  metadataRevision: number
  /** The teammate whose own list in a shared agent's Home holds this page (teammate-rules.ts, rule 4).
   *  Stamped once, when it is published; it never takes or clears the workspace's selection, so
   *  pageless commands and the host's lists keep the host's page. Required, so a page's list can only
   *  be read from its record (`TabListRef`). */
  holder: TeammateTabListKey | undefined
}>

export type RuntimeBrowserClientPageInput = Pick<
  RuntimeBrowserClientPage,
  | 'browserPageId'
  | 'workspaceId'
  | 'browserProfileId'
  | 'executionHostKey'
  | 'placement'
  | 'url'
  | 'loading'
  | 'active'
> &
  Partial<
    Pick<
      RuntimeBrowserClientPage,
      'pairedDeviceId' | 'title' | 'canGoBack' | 'canGoForward' | 'metadataRevision'
    >
  >

export type RuntimeBrowserPageUpdate = Partial<
  Pick<RuntimeBrowserClientPage, 'url' | 'title' | 'loading' | 'canGoBack' | 'canGoForward'>
>

export type RuntimeBrowserPageMetadata = Pick<
  RuntimeBrowserClientPage,
  'url' | 'title' | 'loading' | 'canGoBack' | 'canGoForward' | 'faviconUrl' | 'metadataRevision'
>
