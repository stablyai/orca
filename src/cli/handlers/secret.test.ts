import { describe, expect, it } from 'vitest'
import { RuntimeClientError } from '../runtime/types'
import { parseSecretRequestWait, runSecretRequest, type SecretRequestCliInput } from './secret'

const HINT =
  'STRIPE_KEY is set for new shells in this workspace. To use it in this shell: eval "$(orca-env)" (fish: orca-env --fish | source).'

function harness(answers: { request: unknown; statuses?: string[] }) {
  const clock = { now: 0 }
  const calls: { method: string; params: unknown }[] = []
  const printed: string[] = []
  const statuses = [...(answers.statuses ?? [])]
  return {
    calls,
    printed,
    deps: {
      call: async <T>(method: string, params: unknown): Promise<T> => {
        calls.push({ method, params })
        if (method === 'secrets.request') {
          if (answers.request instanceof Error) {
            throw answers.request
          }
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: canned reply for this method.
          return answers.request as T
        }
        const status = statuses.shift() ?? 'pending'
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: canned requestStatus reply.
        return { requestId: 'sr_abcdefgh', name: 'STRIPE_KEY', status, expiresAt: 0 } as T
      },
      sleep: async (ms: number) => {
        clock.now += ms
      },
      now: () => clock.now,
      print: (line: string) => printed.push(line)
    }
  }
}

const base: SecretRequestCliInput = {
  name: 'STRIPE_KEY',
  reason: 'Run the checkout tests',
  waitSec: null,
  json: false,
  worktreeId: 'wt-1'
}

describe('orca secret request', () => {
  it('names no terminal or agent: orcad derives them from verified launch evidence', async () => {
    const h = harness({ request: { requestId: 'sr_abcdefgh', status: 'pending' } })
    await runSecretRequest({ ...base, scope: 'repo' }, h.deps)
    expect(h.calls[0]).toEqual({
      method: 'secrets.request',
      params: {
        name: 'STRIPE_KEY',
        reason: 'Run the checkout tests',
        scope: 'repo',
        worktreeId: 'wt-1'
      }
    })
  })

  it('without --wait, reports the pending request and exits 0', async () => {
    const h = harness({ request: { requestId: 'sr_abcdefgh', status: 'pending' } })
    await expect(runSecretRequest(base, h.deps)).resolves.toBe(0)
    expect(h.printed).toEqual([
      'Asked the person for STRIPE_KEY (sr_abcdefgh). Add --wait <sec> to wait for the answer.'
    ])
  })

  it('with --wait, polls until provided and prints the D4 reload hint exactly', async () => {
    const h = harness({
      request: { requestId: 'sr_abcdefgh', status: 'pending' },
      statuses: ['pending', 'pending', 'provided']
    })
    await expect(runSecretRequest({ ...base, waitSec: 60 }, h.deps)).resolves.toBe(0)
    expect(h.printed).toEqual([HINT])
    expect(h.calls.filter((c) => c.method === 'secrets.requestStatus')).toHaveLength(3)
  })

  it('prints JSON with the hint when provided', async () => {
    const h = harness({
      request: { requestId: 'sr_abcdefgh', status: 'pending' },
      statuses: ['provided']
    })
    await runSecretRequest({ ...base, waitSec: 60, json: true }, h.deps)
    expect(JSON.parse(h.printed[0])).toEqual({
      requestId: 'sr_abcdefgh',
      name: 'STRIPE_KEY',
      status: 'provided',
      hint: HINT
    })
  })

  it('exits 1 when declined, expired, or the wait runs out', async () => {
    for (const [status, line] of [
      ['declined', 'The person declined to provide STRIPE_KEY.'],
      ['expired', 'The request for STRIPE_KEY expired before anyone answered it.']
    ]) {
      const h = harness({
        request: { requestId: 'sr_abcdefgh', status: 'pending' },
        statuses: [status]
      })
      await expect(runSecretRequest({ ...base, waitSec: 60 }, h.deps)).resolves.toBe(1)
      expect(h.printed).toEqual([line])
    }
    const h = harness({ request: { requestId: 'sr_abcdefgh', status: 'pending' } })
    await expect(runSecretRequest({ ...base, waitSec: 5 }, h.deps)).resolves.toBe(1)
    expect(h.printed[0]).toBe(
      'Still waiting for STRIPE_KEY (sr_abcdefgh). Run the same command again to keep waiting.'
    )
  })

  it('reports already-set without polling', async () => {
    const h = harness({ request: { requestId: null, status: 'already-set' } })
    await expect(runSecretRequest({ ...base, waitSec: 60 }, h.deps)).resolves.toBe(0)
    expect(h.calls).toHaveLength(1)
    expect(h.printed[0]).toContain('STRIPE_KEY is already set in this workspace.')
  })

  it('explains refusals in words', async () => {
    const h = harness({
      request: new RuntimeClientError('runtime_error', 'use_sign_in_or_cloud_secrets')
    })
    await expect(runSecretRequest({ ...base, name: 'ANTHROPIC_API_KEY' }, h.deps)).rejects.toThrow(
      "ANTHROPIC_API_KEY is an agent credential: it comes from the person's sign-in or Orca Cloud secrets and can't be requested."
    )
  })

  it('parses --wait', () => {
    expect(parseSecretRequestWait(undefined)).toBeNull()
    expect(parseSecretRequestWait(true)).toBe(900)
    expect(parseSecretRequestWait('30')).toBe(30)
    expect(parseSecretRequestWait('99999')).toBe(3600)
    expect(() => parseSecretRequestWait('soon')).toThrow('--wait takes a number of seconds')
    expect(() => parseSecretRequestWait('0')).toThrow()
  })
})
