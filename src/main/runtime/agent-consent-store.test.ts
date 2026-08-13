/**
 * Unit tests for the Agent Consent Store (P1-1).
 */

import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { AgentConsentStore, AGENT_CONSENT_STORE_FILENAME } from './agent-consent-store'

const createdDirs: string[] = []

async function makeUserDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-agent-consent-test-'))
  createdDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('AgentConsentStore', () => {
  describe('query on an empty store', () => {
    it('returns unknown for a pair that was never recorded', async () => {
      const dir = await makeUserDataDir()
      const store = new AgentConsentStore(dir)
      expect(store.query('codex', 'pi')).toBe('unknown')
    })
  })

  describe('record then query round-trip', () => {
    it('returns allow after recording an allow decision', async () => {
      const dir = await makeUserDataDir()
      const store = new AgentConsentStore(dir)
      store.record({ sourceAgentType: 'codex', targetAgentType: 'pi', decision: 'allow' })
      expect(store.query('codex', 'pi')).toBe('allow')
    })

    it('returns deny after recording a deny decision', async () => {
      const dir = await makeUserDataDir()
      const store = new AgentConsentStore(dir)
      store.record({ sourceAgentType: 'codex', targetAgentType: 'pi', decision: 'deny' })
      expect(store.query('codex', 'pi')).toBe('deny')
    })

    it('a later record() overwrites an earlier decision for the same pair', () => {
      return makeUserDataDir().then((dir) => {
        const store = new AgentConsentStore(dir)
        store.record({ sourceAgentType: 'codex', targetAgentType: 'pi', decision: 'allow' })
        expect(store.query('codex', 'pi')).toBe('allow')
        store.record({ sourceAgentType: 'codex', targetAgentType: 'pi', decision: 'deny' })
        expect(store.query('codex', 'pi')).toBe('deny')
      })
    })

    it('keeps decisions for distinct (source, target) pairs independent', async () => {
      const dir = await makeUserDataDir()
      const store = new AgentConsentStore(dir)
      store.record({ sourceAgentType: 'codex', targetAgentType: 'pi', decision: 'allow' })
      store.record({ sourceAgentType: 'pi', targetAgentType: 'codex', decision: 'deny' })
      store.record({ sourceAgentType: 'codex', targetAgentType: 'prime-agent', decision: 'deny' })

      expect(store.query('codex', 'pi')).toBe('allow')
      expect(store.query('pi', 'codex')).toBe('deny')
      expect(store.query('codex', 'prime-agent')).toBe('deny')
      // Never recorded in either direction.
      expect(store.query('prime-agent', 'pi')).toBe('unknown')
    })

    it('does not collide pairs whose types could ambiguously join with a naive delimiter', async () => {
      const dir = await makeUserDataDir()
      const store = new AgentConsentStore(dir)
      // If keys were built with e.g. `${source}::${target}`, ("a", "bc") and
      // ("ab", "c") would both serialize identically under some delimiter
      // choices. agentConsentPairKey uses JSON array encoding specifically
      // to rule this out.
      store.record({ sourceAgentType: 'a', targetAgentType: 'bc', decision: 'allow' })
      store.record({ sourceAgentType: 'ab', targetAgentType: 'c', decision: 'deny' })

      expect(store.query('a', 'bc')).toBe('allow')
      expect(store.query('ab', 'c')).toBe('deny')
    })
  })

  describe('persistence across instances', () => {
    it('a fresh store instance pointed at the same directory sees a prior record', async () => {
      const dir = await makeUserDataDir()
      const first = new AgentConsentStore(dir)
      first.record({ sourceAgentType: 'codex', targetAgentType: 'pi', decision: 'allow' })

      const second = new AgentConsentStore(dir)
      expect(second.query('codex', 'pi')).toBe('allow')
    })

    it('writes a JSON file under the expected filename in userDataPath', async () => {
      const dir = await makeUserDataDir()
      const store = new AgentConsentStore(dir)
      store.record({ sourceAgentType: 'codex', targetAgentType: 'pi', decision: 'allow' })

      const raw = await readFile(join(dir, AGENT_CONSENT_STORE_FILENAME), 'utf-8')
      const parsed = JSON.parse(raw)
      expect(Array.isArray(parsed)).toBe(true)
      expect(parsed).toHaveLength(1)
      expect(parsed[0]).toMatchObject({
        sourceAgentType: 'codex',
        targetAgentType: 'pi',
        decision: 'allow'
      })
      expect(typeof parsed[0].decidedAt).toBe('number')
    })

    it('list() reflects every recorded pair after reload', async () => {
      const dir = await makeUserDataDir()
      const first = new AgentConsentStore(dir)
      first.record({ sourceAgentType: 'codex', targetAgentType: 'pi', decision: 'allow' })
      first.record({ sourceAgentType: 'pi', targetAgentType: 'codex', decision: 'deny' })

      const second = new AgentConsentStore(dir)
      expect(second.list()).toHaveLength(2)
    })
  })

  describe('corrupt / hostile on-disk data', () => {
    it('treats an unparsable file as an empty store rather than throwing', async () => {
      const dir = await makeUserDataDir()
      await writeFile(join(dir, AGENT_CONSENT_STORE_FILENAME), 'not json{{{', 'utf-8')

      expect(() => new AgentConsentStore(dir)).not.toThrow()
      const store = new AgentConsentStore(dir)
      expect(store.query('codex', 'pi')).toBe('unknown')
    })

    it('drops malformed entries but keeps well-formed ones from the same file', async () => {
      const dir = await makeUserDataDir()
      const payload = [
        { sourceAgentType: 'codex', targetAgentType: 'pi', decision: 'allow', decidedAt: 1 },
        // Missing decidedAt.
        { sourceAgentType: 'bad-1', targetAgentType: 'pi', decision: 'allow' },
        // Invalid decision value — never a valid stored decision.
        { sourceAgentType: 'bad-2', targetAgentType: 'pi', decision: 'maybe', decidedAt: 1 },
        // Not an object at all.
        'not-a-record'
      ]
      await writeFile(join(dir, AGENT_CONSENT_STORE_FILENAME), JSON.stringify(payload), 'utf-8')

      const store = new AgentConsentStore(dir)
      expect(store.query('codex', 'pi')).toBe('allow')
      expect(store.query('bad-1', 'pi')).toBe('unknown')
      expect(store.query('bad-2', 'pi')).toBe('unknown')
      expect(store.list()).toHaveLength(1)
    })
  })

  describe('clear', () => {
    it('clears in-memory decisions without touching the file on disk', async () => {
      const dir = await makeUserDataDir()
      const store = new AgentConsentStore(dir)
      store.record({ sourceAgentType: 'codex', targetAgentType: 'pi', decision: 'allow' })

      store.clear()
      expect(store.query('codex', 'pi')).toBe('unknown')

      // The on-disk file still has the record — a fresh instance reloads it.
      const reloaded = new AgentConsentStore(dir)
      expect(reloaded.query('codex', 'pi')).toBe('allow')
    })
  })
})
