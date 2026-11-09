import { pluginInstallLinkFromArguments } from '../../shared/plugins/catalog/plugin-install-link'
import { skillShareIdFromArguments } from '../../shared/skill-share-link'
import { parseCloudWorkspaceLink } from '../../shared/cloud-workspaces/cloud-workspaces-wire'

const REPEAT_WINDOW_MS = 3_000
const BURST_LIMIT = 5

/** Holds the latest deep link from launch argv or open-url until the renderer pulls or is pushed it. */
export class PendingDeepLinkState {
  private pending: string | null = null
  private recent: { value: string; at: number }[] = []

  constructor(
    private readonly fromArguments: (argv: readonly string[]) => string | null,
    private readonly now: () => number = Date.now
  ) {}

  capture(argv: readonly string[], publish?: (value: string) => void): boolean {
    const value = this.fromArguments(argv)
    if (!value) {
      return false
    }
    // Why: a double click or a page that re-fires the link must not stack pages or toasts.
    const at = this.now()
    this.recent = this.recent.filter((entry) => at - entry.at < REPEAT_WINDOW_MS)
    if (this.recent.some((entry) => entry.value === value) || this.recent.length >= BURST_LIMIT) {
      return true
    }
    this.recent.push({ value, at })
    this.pending = value
    publish?.(value)
    return true
  }

  consume(): string | null {
    const value = this.pending
    this.pending = null
    return value
  }
}

export class SkillShareDeepLinkState extends PendingDeepLinkState {
  constructor() {
    super(skillShareIdFromArguments)
  }
}

/** orca://cloud/w/<id>[/c/<chat>] from launch argv or open-url (team workspace and chat links). */
export class CloudWorkspaceLinkState extends PendingDeepLinkState {
  constructor(now?: () => number) {
    super((argv) => argv.find((arg) => parseCloudWorkspaceLink(arg) !== null) ?? null, now)
  }
}

export class PluginInstallLinkState extends PendingDeepLinkState {
  constructor(now?: () => number) {
    super(pluginInstallLinkFromArguments, now)
  }
}
