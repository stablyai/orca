package expo.modules.orcamobilewebshell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private fun failure(reason: String) = MobileWebShellLoadEmission("failed", reason)

class MobileWebShellLoadStateTest {

  // A prop update on the dead view must not turn a low-memory kill into a crash that spends the JS remount budget.
  @Test
  fun `reports a dead renderer again with the facts of the original loss`() {
    val machine = MobileWebShellLoadStateMachine()
    val lost = mapOf(
      "state" to "failed",
      "reason" to "render-process-gone",
      "background" to true,
      "crashed" to false
    )
    assertEquals(lost, machine.rendererGone(background = true, crashed = false)?.toPayload())
    machine.reset()
    assertEquals(lost, machine.rendererStillGone()?.toPayload())
  }

  @Test
  fun `hears a document only between its commit and the end of that load`() {
    val machine = MobileWebShellLoadStateMachine()
    assertFalse(machine.hasCommittedDocument)
    machine.started()
    // The previous document is alive and same-origin until the next one commits.
    assertFalse(machine.hasCommittedDocument)
    machine.committed()
    assertTrue(machine.hasCommittedDocument)

    // A new prop triple: the committed document is the one being replaced.
    machine.reset()
    assertFalse(machine.hasCommittedDocument)
    machine.committed()
    machine.documentEnded()
    assertFalse(machine.hasCommittedDocument)

    // A failure ends the document, and nothing after it re-arms: a retry is a remount.
    machine.committed()
    machine.failed(MobileWebShellFailureReason.RENDER_PROCESS_GONE)
    assertFalse(machine.hasCommittedDocument)
    machine.committed()
    assertFalse(machine.hasCommittedDocument)
  }

  // Chromium finishes its error document after failure; ready would expose it again.
  @Test
  fun `a load that finished after a failure reports nothing`() {
    val machine = MobileWebShellLoadStateMachine()
    machine.started()
    assertEquals(
      failure("document-load-failed"),
      machine.failed(MobileWebShellFailureReason.DOCUMENT_LOAD_FAILED)
    )
    assertNull(machine.started())
  }

  // A prop update can replace a failed load before its deferred report.
  @Test
  fun `a failure decided before a new prop pair reports nothing`() {
    val machine = MobileWebShellLoadStateMachine()
    machine.started()
    val epoch = machine.epoch
    machine.reset()
    assertNull(machine.failedDuring(epoch, MobileWebShellFailureReason.DOCUMENT_LOAD_FAILED))
    machine.committed()
    assertEquals(MobileWebShellLoadEmission("ready", null), machine.finished())
  }

}
