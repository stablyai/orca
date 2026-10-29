import { createHash } from 'node:crypto'
import type { PluginSyntaxContribution } from '../../../shared/plugins/contributions/plugin-content-pack-contributions'
import {
  PLUGIN_SYNTAX_CONFIGURATION_MAX_BYTES,
  PLUGIN_SYNTAX_GRAMMAR_MAX_BYTES,
  parsePluginGrammarArtifact,
  parsePluginLanguageConfiguration,
  validatePluginGrammarIncludes,
  type PluginGrammarArtifact,
  type PluginLanguageConfiguration,
  type PluginSyntaxMetadata,
  type PluginSyntaxPayload
} from '../../../shared/plugins/artifacts/plugin-syntax-artifact'
import { readContainedPluginArtifactText } from '../plugin-artifact-validation'
import { PluginArtifactPackRegistry } from './plugin-artifact-pack-registry'
import type { PluginContentVerifier } from '../plugin-content-integrity'
import type { DiscoveredPlugin, ValidDiscoveredPlugin } from '../plugin-discovery'

type SyntaxEntry = PluginSyntaxMetadata & {
  scopeName: string
  grammar: PluginGrammarArtifact
  configuration: PluginLanguageConfiguration
}

async function loadSyntax(
  plugin: ValidDiscoveredPlugin,
  contribution: PluginSyntaxContribution
): Promise<SyntaxEntry> {
  const grammarText = await readContainedPluginArtifactText(
    plugin.rootDir,
    contribution.path,
    PLUGIN_SYNTAX_GRAMMAR_MAX_BYTES
  )
  const configurationText = contribution.configuration
    ? await readContainedPluginArtifactText(
        plugin.rootDir,
        contribution.configuration,
        PLUGIN_SYNTAX_CONFIGURATION_MAX_BYTES
      )
    : '{}'
  try {
    return {
      id: `plugin:${plugin.pluginKey}/${contribution.id}`,
      pluginKey: plugin.pluginKey,
      label: contribution.title,
      extensions: contribution.extensions.map((extension) => extension.toLowerCase()),
      filenames: contribution.filenames.map((filename) => filename.toLowerCase()),
      // Why: open files re-tokenize when a plugin update changes the grammar they use.
      revision: createHash('sha256')
        .update(grammarText)
        .update('\0')
        .update(configurationText)
        .digest('hex')
        .slice(0, 32),
      scopeName: contribution.scopeName,
      grammar: parsePluginGrammarArtifact(grammarText, contribution.scopeName),
      configuration: parsePluginLanguageConfiguration(configurationText)
    }
  } catch (error) {
    throw new Error(
      `syntax "${contribution.id}": ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/** Validates every syntax grammar when its plugin is approved, and hands one language's
 *  grammars to the renderer only when a matching file opens. */
export class PluginSyntaxRegistry {
  private readonly entries: PluginArtifactPackRegistry<PluginSyntaxContribution, SyntaxEntry>
  private readonly includeErrors = new Map<string, string>()

  constructor(contentVerifier: PluginContentVerifier) {
    this.entries = new PluginArtifactPackRegistry({
      contentVerifier,
      contributions: (plugin) => plugin.manifest.contributes.syntaxes,
      load: loadSyntax
    })
  }

  private valid(): SyntaxEntry[] {
    return this.entries.list().filter((entry) => !this.includeErrors.has(entry.pluginKey))
  }

  list(): PluginSyntaxMetadata[] {
    return this.valid().map(({ id, pluginKey, label, extensions, filenames, revision }) => ({
      id,
      pluginKey,
      label,
      extensions,
      filenames,
      revision
    }))
  }

  error(pluginKey: string): string | null {
    return this.entries.error(pluginKey) ?? this.includeErrors.get(pluginKey) ?? null
  }

  async reconcile(
    discovered: readonly DiscoveredPlugin[],
    isApproved: (plugin: ValidDiscoveredPlugin) => boolean
  ): Promise<void> {
    await this.entries.reconcile(discovered, isApproved)
    // Why at approval: a broken include then shows on the plugin card, and opening a file never
    // pays for the check.
    this.includeErrors.clear()
    const byPlugin = new Map<string, PluginGrammarArtifact[]>()
    for (const entry of this.entries.list()) {
      const grammars = byPlugin.get(entry.pluginKey) ?? []
      grammars.push(entry.grammar)
      byPlugin.set(entry.pluginKey, grammars)
    }
    for (const [pluginKey, grammars] of byPlugin) {
      try {
        validatePluginGrammarIncludes(grammars)
      } catch (error) {
        this.includeErrors.set(pluginKey, error instanceof Error ? error.message : String(error))
      }
    }
  }

  load(id: string): PluginSyntaxPayload | null {
    const all = this.valid()
    const entry = all.find((candidate) => candidate.id === id)
    if (!entry) {
      return null
    }
    // Why the whole plugin: a grammar may include its sibling grammars' scopes.
    const grammars = all
      .filter((candidate) => candidate.pluginKey === entry.pluginKey)
      .map((candidate) => candidate.grammar)
    return {
      id: entry.id,
      revision: entry.revision,
      scopeName: entry.scopeName,
      grammars: [entry.grammar, ...grammars.filter((grammar) => grammar !== entry.grammar)],
      configuration: entry.configuration
    }
  }
}
