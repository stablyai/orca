package expo.modules.orcamobilewebshell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private fun failure(reason: String) = MobileWebShellLoadEmission("failed", reason)

class MobileWebShellLoadStateTest {
  @Test
  fun `spells each reason the way the TypeScript parser reads it`() {
    assertEquals(
      listOf(
        "generation-unreadable",
        "isolation-unavailable",
        "document-load-failed",
        "render-process-gone"
      ),
      MobileWebShellFailureReason.entries.map { it.wireName }
    )
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

  @Test
  fun `reports a load in progress and then a load that finished`() {
    val machine = MobileWebShellLoadStateMachine()
    assertEquals(MobileWebShellLoadEmission("loading", null), machine.started())
    assertEquals(MobileWebShellLoadEmission("ready", null), machine.finished())
  }

  @Test
  fun `says nothing twice in a row`() {
    val machine = MobileWebShellLoadStateMachine()
    assertNotNull(machine.started())
    assertNull(machine.started())
    assertNotNull(machine.finished())
    assertNull(machine.finished())
  }

  // Chromium commits its error document after onReceivedError returns, so onPageFinished arrives
  // after the failure; reporting `ready` there would also un-hide the error page.
  @Test
  fun `a load that finished after a failure reports nothing`() {
    val machine = MobileWebShellLoadStateMachine()
    machine.started()
    assertEquals(
      failure("document-load-failed"),
      machine.failed(MobileWebShellFailureReason.DOCUMENT_LOAD_FAILED)
    )
    assertNull(machine.finished())
    assertNull(machine.started())
  }

  @Test
  fun `a second failure reports nothing, whatever its reason`() {
    val machine = MobileWebShellLoadStateMachine()
    assertEquals(
      failure("generation-unreadable"),
      machine.failed(MobileWebShellFailureReason.GENERATION_UNREADABLE)
    )
    assertNull(machine.failed(MobileWebShellFailureReason.GENERATION_UNREADABLE))
    assertNull(machine.failed(MobileWebShellFailureReason.ISOLATION_UNAVAILABLE))
    assertNull(machine.failed(MobileWebShellFailureReason.RENDER_PROCESS_GONE))
  }

  // Android defers a document failure past Chromium's error document, so a prop update can land
  // between the decision and the report; the failure belongs to the load that is already gone.
  @Test
  fun `a failure decided before a new prop pair reports nothing`() {
    val machine = MobileWebShellLoadStateMachine()
    machine.started()
    val epoch = machine.epoch
    machine.reset()
    assertNull(machine.failedDuring(epoch, MobileWebShellFailureReason.DOCUMENT_LOAD_FAILED))
    assertEquals(MobileWebShellLoadEmission("ready", null), machine.finished())
  }

  @Test
  fun `a failure decided during the current load still reports`() {
    val machine = MobileWebShellLoadStateMachine()
    machine.started()
    assertEquals(
      failure("document-load-failed"),
      machine.failedDuring(machine.epoch, MobileWebShellFailureReason.DOCUMENT_LOAD_FAILED)
    )
  }

  @Test
  fun `a new prop pair may report again, including the same failure`() {
    val machine = MobileWebShellLoadStateMachine()
    machine.failed(MobileWebShellFailureReason.RENDER_PROCESS_GONE)
    machine.reset()
    assertEquals(
      failure("render-process-gone"),
      machine.failed(MobileWebShellFailureReason.RENDER_PROCESS_GONE)
    )
  }
}
