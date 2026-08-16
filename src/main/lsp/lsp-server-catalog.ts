import { isCommandOnLocalPath } from '../ipc/command-path-resolver'

export type LspServerDescriptor = {
  serverId: string
  command: string
  args: readonly string[]
}

type LspServerCatalogEntry = {
  languages: readonly string[]
  /** Tried in order; the first command found on PATH wins. */
  candidates: readonly LspServerDescriptor[]
}

/** Servers Orca knows how to drive. Nothing is bundled: a server is used only
 *  when the user already has its binary on PATH. */
export const LSP_SERVER_CATALOG: readonly LspServerCatalogEntry[] = [
  {
    languages: ['typescript', 'javascript'],
    candidates: [
      // Why: tsgo (native TypeScript 7 / @typescript/native-preview) is the
      // fast path and the only server that works in tsserver-less TS7 repos.
      { serverId: 'tsgo', command: 'tsgo', args: ['--lsp', '--stdio'] },
      {
        serverId: 'typescript-language-server',
        command: 'typescript-language-server',
        args: ['--stdio']
      }
    ]
  },
  {
    languages: ['python'],
    candidates: [{ serverId: 'pyright', command: 'pyright-langserver', args: ['--stdio'] }]
  },
  { languages: ['go'], candidates: [{ serverId: 'gopls', command: 'gopls', args: [] }] },
  {
    languages: ['rust'],
    candidates: [{ serverId: 'rust-analyzer', command: 'rust-analyzer', args: [] }]
  }
]

// Why: PATH probing hits the filesystem; editors re-open files constantly, so
// remember each verdict for the app lifetime (installing a server mid-session
// is picked up after restart, like agent detection).
const availabilityByCommand = new Map<string, Promise<boolean>>()

function isServerCommandAvailable(
  command: string,
  probe: (command: string) => Promise<boolean>
): Promise<boolean> {
  let availability = availabilityByCommand.get(command)
  if (!availability) {
    availability = probe(command).catch(() => false)
    availabilityByCommand.set(command, availability)
  }
  return availability
}

export async function resolveLspServerForLanguage(
  languageId: string,
  probe: (command: string) => Promise<boolean> = isCommandOnLocalPath
): Promise<LspServerDescriptor | null> {
  const entry = LSP_SERVER_CATALOG.find((candidate) => candidate.languages.includes(languageId))
  if (!entry) {
    return null
  }
  for (const descriptor of entry.candidates) {
    if (await isServerCommandAvailable(descriptor.command, probe)) {
      return descriptor
    }
  }
  return null
}

export function resetLspServerAvailabilityForTests(): void {
  availabilityByCommand.clear()
}

/** Monaco has no react language ids (.tsx shares 'typescript'), but LSP servers
 *  key script kind off the didOpen languageId — tsserver parses a 'typescript'
 *  .tsx as plain TS and errors on every JSX element. */
export function toLspDocumentLanguageId(languageId: string, filePath: string): string {
  if (languageId === 'typescript' && /\.tsx$/i.test(filePath)) {
    return 'typescriptreact'
  }
  if (languageId === 'javascript' && /\.jsx$/i.test(filePath)) {
    return 'javascriptreact'
  }
  return languageId
}
