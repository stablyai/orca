import {
  PLUGIN_MARKDOWN_OUTPUT_MAX_BYTES,
  pluginMarkdownCancelRequestSchema,
  pluginMarkdownRenderRequestSchema,
  pluginMarkdownWorkerResultSchema,
  type PluginMarkdownRenderResult,
  type PluginMarkdownRendererRegistration,
  type PluginMarkdownSource,
  type PluginMarkdownSourceResult
} from '../../shared/plugins/plugin-markdown-renderer'
import { structuredCloneMessageBytes } from '../../shared/plugins/plugin-panel-message-budget'
import { isInvalidDiscoveredPlugin, type ValidDiscoveredPlugin } from './plugin-discovery'
import { validatePluginMarkdownReferences } from './plugin-markdown-references'
import {
  resolvePluginMarkdownSource,
  type PluginMarkdownSourceAuthority
} from './plugin-markdown-source'
import type { PluginService } from './plugin-service'

const MAX_PENDING_PER_PROVIDER = 4
const MAX_PENDING_PER_OWNER = 64
const MAX_PENDING_TOTAL = 128

type MarkdownRendererDependencies = {
  plugins(): ValidDiscoveredPlugin[]
  available(plugin: ValidDiscoveredPlugin): boolean
  resolveSource(source: PluginMarkdownSource): Promise<PluginMarkdownSourceResult>
  invoke(pluginKey: string, commandId: string, args: unknown): Promise<unknown>
  resolveSourceRequest?(raw: unknown): Promise<PluginMarkdownSourceResult>
}

const staleResult = (): PluginMarkdownRenderResult => ({
  status: 'error',
  code: 'stale-context',
  message: 'The source or provider changed before rendering completed.'
})

export class PluginMarkdownRenderer {
  private readonly pending = new Map<string, Map<string, object>>()
  private readonly providerPending = new Map<string, number>()
  private pendingCount = 0

  constructor(private readonly dependencies: MarkdownRendererDependencies) {}

  resolveSource(raw: unknown): Promise<PluginMarkdownSourceResult> {
    return (
      this.dependencies.resolveSourceRequest?.(raw) ??
      Promise.resolve({ status: 'unavailable', reason: 'unsupported-context' })
    )
  }

  list(): PluginMarkdownRendererRegistration[] {
    const providers = this.dependencies
      .plugins()
      .flatMap((plugin) =>
        plugin.manifest.contributes.markdownRenderers.map((renderer) => ({ plugin, renderer }))
      )
    return providers.map(({ plugin, renderer }) => ({
      language: renderer.language,
      pluginKey: plugin.pluginKey,
      available:
        this.dependencies.available(plugin) &&
        providers.filter((entry) => entry.renderer.language === renderer.language).length === 1
    }))
  }

  cancel(owner: string, raw: unknown): void {
    const parsed = pluginMarkdownCancelRequestSchema.safeParse(raw)
    if (parsed.success) {
      const sessions = this.pending.get(owner)
      sessions?.delete(parsed.data.sessionId)
      if (sessions?.size === 0) {
        this.pending.delete(owner)
      }
    }
  }

  revokeOwner(owner: string): void {
    this.pending.delete(owner)
  }

  async render(owner: string, raw: unknown): Promise<PluginMarkdownRenderResult> {
    if (structuredCloneMessageBytes(raw, 320 * 1024) > 320 * 1024) {
      return { status: 'error', code: 'invalid-request', message: 'Render request is too large.' }
    }
    const parsed = pluginMarkdownRenderRequestSchema.safeParse(raw)
    if (!parsed.success) {
      return {
        status: 'error',
        code: 'invalid-request',
        message: 'Invalid Markdown render request.'
      }
    }
    const request = parsed.data
    const matches = this.dependencies
      .plugins()
      .flatMap((plugin) =>
        plugin.manifest.contributes.markdownRenderers
          .filter((renderer) => renderer.language === request.language)
          .map((renderer) => ({ plugin, renderer }))
      )
    if (matches.length !== 1) {
      return {
        status: 'unavailable',
        reason: matches.length === 0 ? 'missing-provider' : 'ambiguous-provider'
      }
    }
    const { plugin, renderer } = matches[0]!
    if (!this.dependencies.available(plugin)) {
      return { status: 'unavailable', reason: 'disabled-provider' }
    }
    const sessions = this.pending.get(owner) ?? new Map<string, object>()
    const providerCount = this.providerPending.get(plugin.pluginKey) ?? 0
    if (
      providerCount >= MAX_PENDING_PER_PROVIDER ||
      sessions.size >= MAX_PENDING_PER_OWNER ||
      this.pendingCount >= MAX_PENDING_TOTAL
    ) {
      return {
        status: 'error',
        code: 'provider-error',
        message: 'Renderer is busy. Try again later.'
      }
    }
    const token = {}
    sessions.set(request.sessionId, token)
    this.pending.set(owner, sessions)
    this.providerPending.set(plugin.pluginKey, providerCount + 1)
    this.pendingCount += 1
    const isCurrent = (): boolean =>
      this.pending.get(owner)?.get(request.sessionId) === token &&
      this.dependencies.plugins().includes(plugin) &&
      this.dependencies.available(plugin)
    const sourceCurrent = async (): Promise<boolean> => {
      const source = await this.dependencies.resolveSource(request.source)
      return (
        source.status === 'resolved' &&
        (['runtimeId', 'worktreeId', 'fileId', 'documentPath', 'workspacePath'] as const).every(
          (key) => source.source[key] === request.source[key]
        )
      )
    }
    try {
      if (!(await sourceCurrent())) {
        return { status: 'unavailable', reason: 'unsupported-context' }
      }
      if (!isCurrent()) {
        return staleResult()
      }
      const rawResult = await this.dependencies.invoke(
        plugin.pluginKey,
        renderer.commandId,
        request
      )
      if (!isCurrent() || !(await sourceCurrent())) {
        return staleResult()
      }
      if (
        structuredCloneMessageBytes(rawResult, PLUGIN_MARKDOWN_OUTPUT_MAX_BYTES) >
        PLUGIN_MARKDOWN_OUTPUT_MAX_BYTES
      ) {
        return { status: 'error', code: 'invalid-output', message: 'Renderer output is too large.' }
      }
      const result = pluginMarkdownWorkerResultSchema.safeParse(rawResult)
      if (
        !result.success ||
        result.data.sessionId !== request.sessionId ||
        Buffer.byteLength(JSON.stringify(result.data), 'utf8') > PLUGIN_MARKDOWN_OUTPUT_MAX_BYTES ||
        !(await validatePluginMarkdownReferences(request.source, result.data.output))
      ) {
        return { status: 'error', code: 'invalid-output', message: 'Invalid renderer output.' }
      }
      if (!isCurrent()) {
        return staleResult()
      }
      return { status: 'rendered', pluginKey: plugin.pluginKey, ...result.data }
    } catch {
      return isCurrent()
        ? {
            status: 'error',
            code: 'provider-error',
            message: 'The plugin could not render this block.'
          }
        : staleResult()
    } finally {
      this.pendingCount -= 1
      const count = (this.providerPending.get(plugin.pluginKey) ?? 1) - 1
      if (count > 0) {
        this.providerPending.set(plugin.pluginKey, count)
      } else {
        this.providerPending.delete(plugin.pluginKey)
      }
      if (sessions.get(request.sessionId) === token) {
        sessions.delete(request.sessionId)
      }
      if (sessions.size === 0 && this.pending.get(owner) === sessions) {
        this.pending.delete(owner)
      }
    }
  }
}

export function createServicePluginMarkdownRenderer(
  service: Pick<PluginService, 'getDiscovered' | 'canStartPluginWork' | 'invokeCommand'>,
  authority: () => Partial<PluginMarkdownSourceAuthority> | null
): PluginMarkdownRenderer {
  const resolveSourceRequest = (raw: unknown): Promise<PluginMarkdownSourceResult> => {
    const delegate = authority()
    const getRuntimeId = delegate?.getRuntimeId?.bind(delegate)
    const showTerminalWorkspaceLaunchScope =
      delegate?.showTerminalWorkspaceLaunchScope?.bind(delegate)
    return resolvePluginMarkdownSource(
      getRuntimeId && showTerminalWorkspaceLaunchScope
        ? { getRuntimeId, showTerminalWorkspaceLaunchScope }
        : null,
      raw
    )
  }
  return new PluginMarkdownRenderer({
    plugins: () =>
      service
        .getDiscovered()
        .filter((plugin): plugin is ValidDiscoveredPlugin => !isInvalidDiscoveredPlugin(plugin)),
    available: (plugin) => service.canStartPluginWork(plugin),
    resolveSource: (source) =>
      resolveSourceRequest({
        fileId: source.fileId,
        documentPath: source.documentPath,
        worktreeId: source.worktreeId,
        runtimeEnvironmentId: null
      }),
    resolveSourceRequest,
    invoke: (pluginKey, commandId, args) => service.invokeCommand(pluginKey, commandId, args)
  })
}
