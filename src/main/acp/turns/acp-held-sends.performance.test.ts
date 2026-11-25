import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AcpStructuredTurns } from './acp-structured-turns'
import { AcpStructuredLane } from '../journal/acp-structured-lane'
import { GENERIC_ACP_DIALECT } from '../acp-dialects/acp-dialect'
import { captureStructuredAgentSessionWorkAuthority } from '../../native-chat/agent-session-wire/observations/structured-agent-session-work-authority'
import {
  HOST_TEST_LOCATION,
  HOST_TEST_SESSION
} from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { agentSessionRecordFixture } from '../../native-chat/testing/agent-session-record-test-fixture'
import {
  closeTestAgentSessionDatabase,
  openTestAgentSessionDatabase
} from '../../runtime/agent-session/records/agent-session-record-store-test-harness'
import { SqlAgentSessionJournal } from '../../native-chat/agent-session-journal/journal-sql-store'

// PR #45057: ACP copied growing and shrinking held-send sets during Steer and Stop.
it.each([16, 160, 100, 1000])(
  'captures ACP ownership through %i steers and Stop',
  async (count) => {
    const directory = await mkdtemp(join(tmpdir(), 'acp-held-sends-'))
    try {
      const sessionId = HOST_TEST_SESSION
      const now = () => 1_800_000_000_000
      const journal = await SqlAgentSessionJournal.open({
        database: await openTestAgentSessionDatabase(directory),
        identity: {
          sessionId,
          workspaceId: HOST_TEST_LOCATION.workspaceId,
          hostId: 'local',
          agent: 'grok',
          providerHandle: null
        },
        now
      })
      const lane = new AcpStructuredLane({
        sink: { tryAppendTransition: () => ({ accepted: true }) },
        sessionId,
        agent: 'grok',
        agentName: 'Grok',
        generation: 'child',
        providerSessionId: 'provider',
        dialect: GENERIC_ACP_DIALECT,
        logger: { warn: () => {}, error: () => {} },
        onInputAccepted: () => {},
        onFailed: () => {}
      })
      const stopCaptures: (string[] | undefined)[] = []
      const turns = new AcpStructuredTurns({
        lane,
        connection: { prompt: () => new Promise(() => {}), cancel: async () => {} },
        agentName: 'Grok',
        now,
        settle: () => {
          stopCaptures.push(capture())
        },
        withdrawRequests: () => {},
        sessionLost: () => {}
      })
      const deps = {
        sessions: new Map([
          [
            sessionId,
            {
              journal,
              params: {
                location: HOST_TEST_LOCATION,
                provider: agentSessionRecordFixture({ sessionId }).provider
              },
              child: {
                fence: 1,
                phase: 'ready' as const,
                generation: 'child',
                heldSends: () => turns.heldSends
              }
            }
          ]
        ]),
        getConversation: () => null
      }
      const capture = () =>
        captureStructuredAgentSessionWorkAuthority(journal, sessionId, deps, {
          cursor: journal.cursor(),
          revision: journal.stopMarks.revision(),
          latest: null
        })?.authority.child?.heldSends
      const iterate = Set.prototype[Symbol.iterator]
      let visits = 0
      const counted = vi.spyOn(Set.prototype, Symbol.iterator).mockImplementation(function (
        this: Set<unknown>
      ) {
        if (this.has('active-acp')) {
          visits += this.size
        }
        return iterate.call(this)
      })
      try {
        const dispatch = (clientMessageId: string) =>
          turns.dispatch({ clientMessageId, prompt: [], requestedAt: now() })
        dispatch('active-acp')
        const first = capture()
        expect(first).toEqual(['active-acp'])
        expect(capture()).toBe(first)
        turns.accept('absent')
        expect(capture()).toBe(first)
        for (let index = 0; index < count; index += 1) {
          dispatch(`steer-${index}`)
          if (index + 1 === count / 2) {
            const middle = capture()
            expect(middle).not.toBe(first)
            expect(middle).toHaveLength(count / 2 + 1)
            expect(capture()).toBe(middle)
          }
        }
        const full = capture()
        expect(full).toHaveLength(count + 1)
        expect(capture()).toBe(full)
        expect(turns.stop(now())).toBe(true)
        const stopped = capture()
        expect(stopped).toEqual(['active-acp'])
        expect(stopped).not.toBe(full)
        expect(stopCaptures).toHaveLength(count)
        expect(visits).toBe(3 * count + 8)
        expect(stopCaptures.every((snapshot) => snapshot === stopped)).toBe(true)
        expect(full).toHaveLength(count + 1)

        turns.accept('active-acp')
        expect(capture()).toEqual([])
        dispatch('replacement')
        expect(capture()).toEqual(['replacement'])
      } finally {
        counted.mockRestore()
      }
    } finally {
      await closeTestAgentSessionDatabase(directory)
      await rm(directory, { recursive: true, force: true })
    }
  }
)
