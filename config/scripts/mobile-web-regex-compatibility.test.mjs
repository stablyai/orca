import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'

class RegExpWithoutLookbehind extends RegExp {
  constructor(pattern, flags) {
    const source = typeof pattern === 'string' ? pattern : (pattern?.source ?? '')
    if (source.includes('(?<=') || source.includes('(?<!')) {
      throw new SyntaxError('Lookbehind is unavailable before Safari 16.4')
    }
    super(pattern, flags)
  }
}

async function loadSharedModule(path) {
  // Safari targeting turns unsupported literals into constructors, so the guard covers both forms.
  const result = await build({
    entryPoints: [fileURLToPath(new URL(`../../src/shared/${path}`, import.meta.url))],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'cjs',
    target: ['safari15'],
    logLevel: 'silent'
  })
  const module = { exports: {} }
  runInNewContext(result.outputFiles[0].text, { module, RegExp: RegExpWithoutLookbehind })
  return module.exports
}

describe('shared mobile modules without WebKit lookbehind', () => {
  it('loads agent token matchers and preserves executable and path boundaries', async () => {
    const agent = await loadSharedModule('agent-name-token-match.ts')
    expect(agent.titleHasAgentName('Codex.exe ready', 'codex')).toBe(true)
    expect(agent.titleHasAgentName('C:\\codex.exe\\ready', 'codex')).toBe(false)
    expect(agent.titleHasAnyLegacyAgentName('~/openclaude-project')).toBe(false)
    expect(agent.DROID_AGENT_NAME_RE.test('Droid ready')).toBe(true)
    expect(agent.DROID_AGENT_NAME_RE.test('android ready')).toBe(false)
    expect(agent.HERMES_AGENT_NAME_RE.test('Hermes ready')).toBe(true)
    expect(agent.AGY_AGENT_NAME_RE.test('agy ready')).toBe(true)
  })

  it('loads title status classification and preserves cleanup delimiters', async () => {
    const status = await loadSharedModule('agent-title-status.ts')
    expect(status.detectAgentStatusFromTitle('Codex working')).toBe('working')
    expect(status.detectAgentStatusFromTitle('Codex done.')).toBe('idle')
    expect(status.clearWorkingIndicators('Codex:working;thinking|running!')).toBe('Codex:;|!')
  })

  it('loads compatible title ownership and retains idle normalization', async () => {
    const owner = await loadSharedModule('agent-title-owner.ts')
    expect(owner.normalizeCompatibleAgentTitleForOwner('Pi ready', 'omp')).toBe('OMP ready')
  })

  it('loads JQL detection without broadening prose into operators', async () => {
    const jira = await loadSharedModule('jira/jira-search-input-jql.ts')
    expect(jira.mayBeJql('status WAS Done')).toBe(true)
    expect(jira.mayBeJql('status IN(Open)')).toBe(true)
    expect(jira.mayBeJql('labels IS NOT EMPTY')).toBe(true)
    expect(jira.mayBeJql('sign-in page')).toBe(false)
    expect(jira.mayBeJql('crash in terminal')).toBe(false)
    expect(jira.mayBeJql('login is slow')).toBe(false)
  })
})
