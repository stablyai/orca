import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'
import type { IRawGrammar } from 'vscode-textmate'
import type { CustomLanguageSnapshot } from '../../shared/custom-languages'
import {
  extensionResourcePath,
  languageConfigurationSchema,
  languageMetadataSchema,
  readLanguageJson,
  resolveLanguagePath
} from './language-files'

const configSchema = z.object({
  extensions: z.array(z.string()).max(64).default([]),
  grammars: z.array(z.string()).max(128).default([]),
  languages: z.array(z.unknown()).max(128).default([])
})
const directLanguageSchema = languageMetadataSchema.extend({
  grammar: z.string(),
  scopeName: z.string().optional()
})
const extensionSchema = z.object({
  contributes: z.object({
    languages: z.array(z.unknown()).max(128).default([]),
    grammars: z.array(z.unknown()).max(128).default([])
  })
})
const grammarContributionSchema = z.object({
  language: z.string().optional(),
  scopeName: z.string(),
  path: z.string()
})
const grammarSchema = z
  .object({
    scopeName: z.string().min(1).max(256),
    patterns: z.array(z.unknown())
  })
  .passthrough()

export async function readCustomLanguages(
  configPath = join(homedir(), '.orca', 'languages.json')
): Promise<CustomLanguageSnapshot> {
  const snapshot: CustomLanguageSnapshot = { languages: [], grammars: {}, diagnostics: [] }
  const grammars = new Map<string, IRawGrammar>()
  const languageIds = new Set<string>()
  let totalBytes = 0
  const attempt = async (label: string, action: () => Promise<void>): Promise<void> => {
    try {
      await action()
    } catch (error) {
      snapshot.diagnostics.push(
        `${label}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  const addGrammar = async (path: string, expectedScope?: string): Promise<string> => {
    const grammar = grammarSchema.parse(await readLanguageJson(path))
    if (expectedScope && expectedScope !== grammar.scopeName) {
      throw new Error(`Expected scope ${expectedScope}, found ${grammar.scopeName}`)
    }
    if (grammars.has(grammar.scopeName)) {
      throw new Error(`Duplicate grammar scope ${grammar.scopeName}`)
    }
    const bytes = Buffer.byteLength(JSON.stringify(grammar))
    if (totalBytes + bytes > 16 * 1024 * 1024) {
      throw new Error('Custom grammars exceed 16 MiB total')
    }
    totalBytes += bytes
    grammars.set(grammar.scopeName, grammar as unknown as IRawGrammar)
    return grammar.scopeName
  }
  const addLanguage = async (
    raw: unknown,
    scopeName: string,
    resolveResource: (path: string) => Promise<string>
  ): Promise<void> => {
    const { configuration: configurationPath, ...metadata } = languageMetadataSchema.parse(raw)
    if (languageIds.has(metadata.id)) {
      throw new Error(`Duplicate language id ${metadata.id}`)
    }
    if (!grammars.has(scopeName)) {
      throw new Error(`Missing grammar ${scopeName}`)
    }
    let configuration: z.infer<typeof languageConfigurationSchema> | undefined
    if (configurationPath) {
      await attempt(`${metadata.id} configuration`, async () => {
        configuration = languageConfigurationSchema.parse(
          await readLanguageJson(await resolveResource(configurationPath))
        )
      })
    }
    snapshot.languages.push({ ...metadata, scopeName, configuration })
    languageIds.add(metadata.id)
  }

  let document: unknown
  try {
    document = await readLanguageJson(configPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      snapshot.diagnostics.push(`${configPath}: ${String(error)}`)
    }
    return snapshot
  }
  await attempt(configPath, async () => {
    const config = configSchema.parse(document)
    const resolveResource = async (path: string): Promise<string> =>
      resolveLanguagePath(path, dirname(configPath))
    for (const extensionPath of config.extensions) {
      await attempt(extensionPath, async () => {
        const root = await resolveResource(extensionPath)
        const extension = extensionSchema.parse(await readLanguageJson(join(root, 'package.json')))
        const languageScopes = new Map<string, string>()
        for (const raw of extension.contributes.grammars) {
          await attempt(`${extensionPath} grammar`, async () => {
            const entry = grammarContributionSchema.parse(raw)
            await addGrammar(await extensionResourcePath(root, entry.path), entry.scopeName)
            if (entry.language) {
              languageScopes.set(entry.language, entry.scopeName)
            }
          })
        }
        for (const raw of extension.contributes.languages) {
          await attempt(`${extensionPath} language`, async () => {
            const metadata = languageMetadataSchema.parse(raw)
            const scopeName = languageScopes.get(metadata.id)
            if (!scopeName) {
              throw new Error(`No TextMate grammar associated with language ${metadata.id}`)
            }
            await addLanguage(raw, scopeName, (path) => extensionResourcePath(root, path))
          })
        }
      })
    }
    for (const path of config.grammars) {
      await attempt(path, async () => {
        await addGrammar(await resolveResource(path))
      })
    }
    for (const raw of config.languages) {
      await attempt('Custom language', async () => {
        const entry = directLanguageSchema.parse(raw)
        const previousBytes = totalBytes
        const scopeName = await addGrammar(await resolveResource(entry.grammar), entry.scopeName)
        try {
          await addLanguage(entry, scopeName, resolveResource)
        } catch (error) {
          grammars.delete(scopeName)
          totalBytes = previousBytes
          throw error
        }
      })
    }
  })
  snapshot.grammars = Object.fromEntries(grammars)
  return snapshot
}
