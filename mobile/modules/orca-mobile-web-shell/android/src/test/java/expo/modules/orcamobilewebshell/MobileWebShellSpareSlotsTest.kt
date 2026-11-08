package expo.modules.orcamobilewebshell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileWebShellSpareSlotsTest {
  private class FakePage : MobileWebShellSparePage {
    override var isUsable = true
    var destroyed = false

    override fun destroy() {
      destroyed = true
      isUsable = false
    }
  }

  private val slots = MobileWebShellSpareSlots<FakePage>()

  private fun park(sessionId: String, buildId: String = "build-1", hostKey: String = "host-a"): FakePage {
    val page = FakePage()
    slots.park(MobileWebShellSpareEntry(buildId, hostKey, sessionId, page))
    return page
  }

  @Test
  fun `a spare is handed out once, and only to a directory holding its build`() {
    park("s1")
    assertNull(slots.take("build-2", "build-2", "host-c"))
    assertNull(slots.take("build-1", "build-2", "host-c"))
    assertNull(slots.take("build-1", null, "host-c"))
    assertEquals("s1", slots.take("build-1", "build-1", "host-c")?.sessionId)
    assertNull(slots.take("build-1", "build-1", "host-c"))
  }

  @Test
  fun `a dead spare is never handed out, and a new one is wanted in its place`() {
    val page = park("s1")
    assertFalse(slots.wants("build-1"))
    page.isUsable = false
    assertTrue(slots.wants("build-1"))
    assertNull(slots.take("build-1", "build-1", "host-c"))
  }

  @Test
  fun `a live spare of another build is kept unless the caller replaces it`() {
    park("s1", buildId = "build-1")
    assertFalse(slots.wants("build-2", replace = false))
    assertTrue(slots.wants("build-2", replace = true))
  }

  @Test
  fun `parking replaces the spare app-wide and destroys the one it replaced`() {
    val first = park("s1", buildId = "build-1")
    park("s2", buildId = "build-2")
    assertTrue(first.destroyed)
    assertNull(slots.take("build-1", "build-1", "host-c"))
  }

  @Test
  fun `a claimed spare nobody adopted is destroyed when it expires, and an adopted one is not`() {
    val unadopted = park("s1")
    slots.take("build-1", "build-1", "host-c")
    slots.expire("s1")
    assertTrue(unadopted.destroyed)
    assertNull(slots.adopt("s1"))

    val adopted = park("s2")
    slots.take("build-1", "build-1", "host-c")
    assertEquals(adopted, slots.adopt("s2")?.page)
    slots.expire("s2")
    assertFalse(adopted.destroyed)
  }

  @Test
  fun `a claim whose page died before its view came is destroyed, not adopted`() {
    val page = park("s1")
    slots.take("build-1", "build-1", "host-c")
    page.isUsable = false
    assertNull(slots.adopt("s1"))
    assertTrue(page.destroyed)
  }

  @Test
  fun `removing a host drops the spares reading its files, parked or claimed`() {
    val claimedByB = park("s1", hostKey = "host-a")
    slots.take("build-1", "build-1", "host-b")
    val parkedFromC = park("s2", buildId = "build-2", hostKey = "host-c")
    slots.discard("host-a")
    assertFalse(claimedByB.destroyed)
    assertFalse(parkedFromC.destroyed)
    slots.discard("host-b")
    assertTrue(claimedByB.destroyed)
    assertNull(slots.adopt("s1"))
    slots.discard("host-c")
    assertTrue(parkedFromC.destroyed)
  }
}
