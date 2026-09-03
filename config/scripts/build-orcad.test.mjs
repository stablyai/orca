import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const require = createRequire(import.meta.url)
const electronBuilderConfig = require('../electron-builder.config.cjs')
const buildOrcadSource = readFileSync(
  join(REPO_ROOT, 'config', 'scripts', 'build-orcad.mjs'),
  'utf8'
)

const AGENT_BROWSER_PREFIX = 'node_modules/agent-browser/'

/**
 * The package-relative skill directories the desktop bundle ships beside the binary.
 * `bin/` is excluded because that entry is the binary, which build-orcad already copies.
 */
function desktopAgentBrowserSkillDirs() {
  return electronBuilderConfig.mac.extraResources
    .filter(
      (resource) =>
        typeof resource?.from === 'string' &&
        resource.from.startsWith(AGENT_BROWSER_PREFIX) &&
        !resource.from.startsWith(`${AGENT_BROWSER_PREFIX}bin/`)
    )
    .map((resource) => resource.from.slice(AGENT_BROWSER_PREFIX.length))
}

/**
 * orcad copies the same agent-browser binary the desktop app bundles, so it inherits the
 * same resolution rule: the catalog has to sit beside the binary or `agent-browser skills
 * get core` answers with nothing. Asserted against build-orcad.mjs's source because the
 * script is a side-effecting build — the same shape as the relay-bundle coverage in
 * client-hosted-browser-package-coverage.test.mjs.
 */
describe('build-orcad agent-browser skill catalog', () => {
  it('copies into out/orcad the same catalog the desktop bundle ships', () => {
    // Derived from the desktop list rather than restated, so a rename upstream cannot fix
    // one packaging path and silently leave the other shipping a directory that is gone.
    const skillDirs = desktopAgentBrowserSkillDirs()
    expect(skillDirs).toEqual(['skills/agent-browser', 'skill-data'])
    for (const dir of skillDirs) {
      const segments = dir
        .split('/')
        .map((segment) => `'${segment}'`)
        .join(', ')
      expect(buildOrcadSource).toContain(`join(AGENT_BROWSER_PACKAGE, ${segments})`)
      expect(buildOrcadSource).toContain(`join(OUT_DIR, ${segments})`)
    }
  })

  it('anchors skill-data with the sibling skills directory it needs', () => {
    // Probed against agent-browser 0.27.0: `<binary dir>/skill-data` on its own answers
    // "Skills directory not found", and is only read once `<binary dir>/skills` exists.
    // Shipping skill-data alone would look like a complete catalog and resolve nothing.
    expect(buildOrcadSource).toContain("join(OUT_DIR, 'skills', 'agent-browser')")
    expect(buildOrcadSource).toContain("join(OUT_DIR, 'skill-data')")
  })

  it('copies the catalog as real files rather than links', () => {
    // The orcad deploy uploads out/orcad over SFTP and that walk skips symlinks outright,
    // so a linked tree would land on the host as an empty directory.
    expect(buildOrcadSource).toContain('recursive: true, dereference: true')
  })
})
