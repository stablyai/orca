import { it, expect } from 'vitest'
import {
  createQueuedMessageTestRig,
  eventually
} from './structured-agent-session-queued-message-rig.test-fixture'
import { openRigTurnFor } from './structured-agent-session-queued-rig-turn.test-fixture'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'
import { withNativeChatCutTurnNotices } from '../../../shared/native-chat/transcript/native-chat-cut-turn-notice'

it('real close captures an accepted report whose provider turn arrives during shutdown after Stop(A)', async () => {
  const rig = await createQueuedMessageTestRig({ restartable: true })
  try {
    const working = await rig.workingSend()
    await openRigTurnFor(rig, working)
    const held = rig.send('held at Stop', 'queue-if-active')
    await held.result
    await rig.stop()
    await rig.settleAccepted(working, 'original')
    await openRigTurnFor(rig, working, 'interrupted')
    const report = rig.send('post-Stop report', 'queue-if-active', {
      internal: true,
      from: { kind: 'agent', senders: [], orchestration: null }
    })
    await report.result
    await eventually(async () =>
      expect((await rig.submission(report.id))?.handedOverAt).toBeDefined()
    )
    rig.closeSession.mockImplementationOnce(async () => {
      const session = rig.host.collaboratorsForTests().sessions.get(SESSION)!
      expect(await session.child!.close!.recorded).not.toBeNull()
      await rig.settleAccepted(report.id, 'report')
      await openRigTurnFor(rig, report.id)
      await openRigTurnFor(rig, report.id, 'interrupted')
      return true
    })
    await rig.host.close(SESSION, 'user-close')
    const snapshot = await rig.host.journalSnapshot(SESSION)
    const turn = snapshot.items.find(
      (i) => i.body.kind === 'turn' && i.body.turnId === `turn-of-${report.id}`
    )?.body
    const addedNotices = withNativeChatCutTurnNotices(snapshot.items).length - snapshot.items.length
    expect(turn).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
    expect(addedNotices).toBe(0)
  } finally {
    await rig.dispose()
  }
})
