import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The resume route must not type at a worker.
 *
 * Raw text followed by Enter is how a nudge gets past an approval prompt: the text lands in the
 * dialog and the Enter answers it, which approves an action nobody decided. Orca's answer is the
 * agent-session write gate, and the only way to keep it is to never reach the PTY except through
 * a route that consults it. This reads the resume implementation rather than trusting a comment.
 */
const RESUME_SOURCES = [
  '../../../../orchestration/worker-resume-state.ts',
  './worker-resume.ts'
].map((relative) => ({
  path: relative,
  source: readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}))

const GATED_PROMPT_WRITE = fileURLToPath(
  new URL('../../../../orca-runtime-write-terminal-agent-prompt.ts', import.meta.url)
)

describe('the worker resume write route', () => {
  it.each(RESUME_SOURCES)('sends no submit frame of its own ($path)', ({ source }) => {
    // A literal carriage return, an escaped one, or the shared submit constant: all three are the
    // Enter half of text-plus-Enter.
    expect(source).not.toMatch(/\r/)
    expect(source).not.toContain('\\r')
    expect(source).not.toContain('AGENT_PROMPT_SUBMIT')
    expect(source).not.toMatch(/enter:\s*true/)
  })

  it.each(RESUME_SOURCES)('reaches no PTY or controller directly ($path)', ({ source }) => {
    expect(source).not.toContain('writePty')
    expect(source).not.toContain('ptyController')
    expect(source).not.toContain('sendTerminal(')
    expect(source).not.toContain('writeTerminal')
  })

  it('delivers only through the two routes that carry a guard', () => {
    const implementation = RESUME_SOURCES.find((entry) => entry.path === './worker-resume.ts')!
    expect(implementation.source).toContain('runtime.sendTerminalAgentPrompt(')
    expect(implementation.source).toContain('sendStructuredWorkerPreamble(')
  })

  it('keeps the gate on the route it delivers through', () => {
    // If this ever stops holding, the resume route silently becomes an ungated write.
    const gatedWrite = readFileSync(GATED_PROMPT_WRITE, 'utf8')
    expect(gatedWrite).toContain('agentSessionPtyWriteGate.assertAdmitted')
    expect(gatedWrite).toContain('assertAgentPromptPermissionSafe')
  })
})
