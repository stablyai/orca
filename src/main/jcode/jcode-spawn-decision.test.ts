import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { JcodeSpawnRequest } from '../../shared/jcode-spawn-hook'
import { decideJcodeSpawn } from './jcode-spawn-decision'

const coordinatorSessionId = 'session_pawprint_1792604760602_81cf383ab5bbf2d4'
const request: JcodeSpawnRequest = {
  paneKey: 'tab-root:11111111-1111-4111-8111-111111111111',
  paneSecret: randomUUID(),
  kind: 'swarm-agent',
  sessionId: 'session_piglet_1792604760697_211acdce5650ace5',
  coordinatorSessionId,
  command:
    "'/home/user/.local/bin/jcode' '--fresh-spawn' '--provider' 'claude' '--resume' 'session_piglet_1792604760697_211acdce5650ace5'"
}

describe('decideJcodeSpawn', () => {
  it('nests a captured worker under its matching coordinator', () => {
    expect(
      decideJcodeSpawn(request, { rootSessionId: coordinatorSessionId, owner: undefined })
    ).toEqual({ action: 'open-child' })
  })

  it.each(['another-root', undefined])('opens plain for unmatched root %s', (rootSessionId) => {
    expect(decideJcodeSpawn(request, { rootSessionId, owner: undefined })).toEqual({
      action: 'open-plain'
    })
  })

  it('opens plain when both coordinator and root are unknown', () => {
    expect(
      decideJcodeSpawn(
        { ...request, coordinatorSessionId: undefined },
        {
          rootSessionId: undefined,
          owner: undefined
        }
      )
    ).toEqual({ action: 'open-plain' })
  })

  it.each(['resume', 'selfdev', 'restart', 'jade-relay', 'future-kind'])(
    'opens unowned %s in a plain tab',
    (kind) => {
      expect(
        decideJcodeSpawn(
          { ...request, kind },
          {
            rootSessionId: coordinatorSessionId,
            owner: undefined
          }
        )
      ).toEqual({ action: 'open-plain' })
    }
  )

  for (const role of ['root', 'worker', 'plain'] as const) {
    for (const state of ['creating', 'open'] as const) {
      it(`focuses ${role} owner in ${state} state for every kind`, () => {
        const paneKey = role === 'root' ? request.paneKey : 'tab-owner:owner-leaf'
        for (const kind of [
          'swarm-agent',
          'resume',
          'selfdev',
          'restart',
          'jade-relay',
          'future-kind'
        ]) {
          expect(
            decideJcodeSpawn(
              { ...request, kind },
              {
                rootSessionId: 'mismatched-root',
                owner: { paneKey, role, state }
              }
            )
          ).toEqual({ action: 'focus', paneKey, waitForCreation: state === 'creating' })
        }
      })
    }
  }
})
