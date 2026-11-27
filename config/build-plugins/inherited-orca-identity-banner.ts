// Rolldown loads a shared chunk's dependencies (thousands of modules) before an entry's first import
// runs, so the built Electron host entries drop inherited Orca identity from their banner instead.
import type { Plugin } from 'vite'
import {
  AGENT_TEAMS_TEAM_ID_ENV,
  INHERITED_ORCA_IDENTITY_ENV_KEYS,
  INHERITED_ORCA_TEAM_ENV_KEYS
} from '../../src/main/ipc/pty/host-env/inherited-orca-identity-env'

/** Built entries that start children: the desktop/serve main and the terminal daemon. */
export const HOST_ENTRY_FILE_NAMES: ReadonlySet<string> = new Set(['index.js', 'daemon-entry.js'])

const MARKER = '/* orca: drop inherited identity */'

/** Same drop as dropInheritedOrcaIdentityEnv, as the first statement of a built host entry. */
export function createInheritedOrcaIdentityDropBanner(): string {
  return `${MARKER}
;(() => {
  const env = process.env
  if (env[${JSON.stringify(AGENT_TEAMS_TEAM_ID_ENV)}]) {
    for (const key of ${JSON.stringify(INHERITED_ORCA_TEAM_ENV_KEYS)}) delete env[key]
  }
  for (const key of ${JSON.stringify(INHERITED_ORCA_IDENTITY_ENV_KEYS)}) delete env[key]
})();
`
}

/** Whether the drop is the first code `code` runs: only a hashbang or "use strict" may precede it. */
export function runsInheritedOrcaIdentityDropFirst(code: string): boolean {
  const head = code.replace(/^#![^\n]*\n/, '').replace(/^\s*(["'])use strict\1;?\s*/, '')
  return head.startsWith(MARKER)
}

/** Fails the build when a host entry would run anything before the drop. */
export function createInheritedOrcaIdentityFirstGuardPlugin(): Plugin {
  return {
    name: 'orca-inherited-identity-first-guard',
    generateBundle(_options, bundle) {
      for (const fileName of HOST_ENTRY_FILE_NAMES) {
        const chunk = bundle[fileName]
        if (chunk?.type === 'chunk' && !runsInheritedOrcaIdentityDropFirst(chunk.code)) {
          throw new Error(`${fileName} must drop inherited Orca identity env before anything else`)
        }
      }
    }
  }
}
