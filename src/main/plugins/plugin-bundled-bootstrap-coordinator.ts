import {
  bootstrapBundledPlugins,
  type PluginBundledBootstrapResult
} from './plugin-bundled-bootstrap'

type PluginBundledBootstrapRequest = Parameters<typeof bootstrapBundledPlugins>[0]

export class PluginBundledBootstrapCoordinator {
  private readonly options: PluginBundledBootstrapRequest & {
    isEnabled: () => boolean
    refreshPlugins: () => Promise<void>
    bootstrap?: typeof bootstrapBundledPlugins
  }
  private pending: Promise<void> = Promise.resolve()

  constructor(options: PluginBundledBootstrapCoordinator['options']) {
    this.options = options
  }

  request(): Promise<PluginBundledBootstrapResult | null> {
    const run = this.pending.then(() => this.runOnce())
    // Preserve overlapping startup/toggle request order even after resource-read failure.
    this.pending = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async runOnce(): Promise<PluginBundledBootstrapResult | null> {
    if (!this.options.isEnabled()) {
      return null
    }
    const result = await (this.options.bootstrap ?? bootstrapBundledPlugins)({
      root: this.options.root,
      userDataPath: this.options.userDataPath,
      hostVersion: this.options.hostVersion,
      ...(this.options.blockedPluginReason
        ? { blockedPluginReason: this.options.blockedPluginReason }
        : {})
    })
    if (result.installed.length > 0 || result.retired.length > 0) {
      await this.options.refreshPlugins()
    }
    return result
  }
}
