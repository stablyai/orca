const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { sessionId } = require('./parity-cases.cjs')

function verifierEntry(source) {
  const marker = '  protected async waitForStructuredClaudeTuiProof(input: {'
  assert.equal(source.split(marker).length, 2)
  const method = source.slice(source.indexOf(marker), source.lastIndexOf('\n}'))
  return `
export async function runActualVerifier(fixture: { transcriptPath: string; previousLeafUuid?: string | null }) {
  let attempts = 0
  const resolveSessionFilePath = async () => { attempts++; return fixture.transcriptPath }
  const readClaudeTranscriptLeafUuid = async (file: string, session: string, previous: string | null) =>
    (await proveClaudeTranscriptBranch({ transcriptPath: file, providerSessionId: session, previousLeafUuid: previous })).leafUuid
  const isPathWithinDirectory = () => true
  class ActualVerifier {
    getLivePtyForHandle() { return { pty: { connected: true, paneKey: 'tab:leaf', launchAgent: 'claude' } } }
    hasProviderSessionObservationSource() { return true }
    findAdoptedProviderSession() { return { launchToken: 'fresh-launch', receivedAt: 1 } }
    run() { return this.waitForStructuredClaudeTuiProof({ handle: 'handle', paneKey: 'tab:leaf', sessionId: ${JSON.stringify(sessionId)}, projectsDir: 'fixture-root', previousLeafUuid: fixture.previousLeafUuid ?? null, spawnToken: 'fresh-launch', minimumProviderSessionReceivedAt: 1 }) }
${method}
  }
  try {
    const value = await new ActualVerifier().run()
    return { attempts, outcome: { status: 'fulfilled', value } }
  } catch (error) { return { attempts, outcome: { status: 'rejected', name: error.name, message: error.message } } }
}
`
}

async function compareVerifier(scratch, modules) {
  const row = (uuid, parentUuid) =>
    `${JSON.stringify({ type: 'user', uuid, parentUuid, sessionId })}\n`
  const marker = (leafUuid, provider = sessionId) =>
    `${JSON.stringify({ type: 'last-prompt', leafUuid, sessionId: provider })}\n`
  const root = row('root', null)
  const child = row('child', 'root')
  const cases = [
    {
      name: 'growing-empty-prefix-refreshed-internally',
      contents: '',
      append: root + marker('root'),
      refresh: true
    },
    {
      name: 'growing-missing-marker-refreshed-internally',
      contents: root,
      append: marker('root'),
      refresh: true
    },
    {
      name: 'growing-missing-previous-refreshed-internally',
      contents: root + marker('root'),
      append: child + marker('child'),
      previousLeafUuid: 'child',
      refresh: true
    },
    { name: 'static-empty-fatal', contents: '', error: 'Error' },
    { name: 'static-missing-marker-fatal', contents: root, error: 'Error' },
    {
      name: 'static-missing-previous-fatal',
      contents: root + marker('root'),
      previousLeafUuid: 'child',
      error: 'ClaudeTranscriptPreviousCursorMissingError'
    },
    {
      name: 'growing-conflict-fatal',
      contents: root + row('root', 'foreign') + marker('root'),
      append: child,
      error: 'Error'
    },
    {
      name: 'growing-session-mismatch-fatal',
      contents: root + marker('root', 'foreign'),
      append: child,
      error: 'Error'
    },
    {
      name: 'growing-append-order-fatal',
      contents: child + root + marker('child'),
      append: child,
      error: 'Error'
    },
    {
      name: 'successful-prefix-stays-prefix',
      contents: root + marker('root'),
      append: child + marker('child')
    }
  ]
  const reports = []
  for (const scenario of cases) {
    const phases = {}
    for (const phase of ['baseline', 'windowCandidate']) {
      const file = path.join(scratch, `verifier-${phase}.jsonl`)
      fs.writeFileSync(file, scenario.contents)
      const binding = process.binding('fs')
      const originalFstat = binding.fstat
      let injected = false
      binding.fstat = function (...args) {
        const result = originalFstat.apply(this, args)
        if (typeof result?.then !== 'function') {
          return result
        }
        return result.then((stats) => {
          if (!injected) {
            injected = true
            if (scenario.append) {
              fs.appendFileSync(file, scenario.append)
            }
          }
          return stats
        })
      }
      try {
        phases[phase] = await modules[phase].runActualVerifier({
          transcriptPath: file,
          previousLeafUuid: scenario.previousLeafUuid
        })
      } finally {
        binding.fstat = originalFstat
        fs.unlinkSync(file)
      }
      if (scenario.error) {
        assert.equal(phases[phase].outcome.name, scenario.error, `${scenario.name}/${phase}`)
        assert.equal(phases[phase].attempts, 1)
      }
      if (phase === 'windowCandidate' && scenario.refresh) {
        assert.equal(phases[phase].outcome.status, 'fulfilled')
        assert.equal(phases[phase].attempts, 1)
      }
      if (scenario.name === 'successful-prefix-stays-prefix') {
        assert.equal(phases[phase].outcome.value.leafUuid, 'root')
        assert.equal(phases[phase].attempts, 1)
      }
      if (phases[phase].outcome.value) {
        delete phases[phase].outcome.value.transcriptPath
      }
    }
    reports.push({ name: scenario.name, phases })
  }
  return {
    method:
      'Exact current waitForStructuredClaudeTuiProof method body; live-owner/fresh-hook/path-resolution ports controlled, actual file reader and actual 100ms retry timer.',
    reports
  }
}

module.exports = { verifierEntry, compareVerifier }
