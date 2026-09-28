package expo.modules.orcalocalruntime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class LocalRuntimePureLogicTest {
  private val paths = LocalRuntimePaths(File("/data/user/0/app/files"))

  @Test
  fun orcadArgvRunsBunInsideTheRootfsWithMobilePairing() {
    val argv = ProotCommand.orcadArgv(paths, 6768)
    assertEquals(paths.prootBinary.path, argv.first())
    assertTrue(argv.containsAll(listOf("--kill-on-exit", "--link2symlink", "-r", paths.rootfs.path)))
    assertTrue(argv.contains("ORCA_USER_DATA=/root/.o"))
    assertEquals(
      listOf("/opt/orcad/bun-runtime", "/opt/orcad/orcad.js", "--json", "--mobile-pairing", "--port", "6768"),
      argv.takeLast(6)
    )
  }

  @Test
  fun guestUserDataStaysShortEnoughForUnixSockets() {
    // The daemon socket is <user-data>/daemon/daemon-vNN.sock on the host path; sun_path caps at 108.
    val hostSocket = paths.rootfs.path + LocalRuntimePaths.GUEST_USER_DATA + "/daemon/daemon-v99.sock"
    assertTrue(hostSocket.length < 108)
  }

  @Test
  fun readinessLineYieldsEndpointAndPairingUrl() {
    val line = """{"type":"orca_server_ready","schemaVersion":1,"endpoint":"ws://127.0.0.1:6768",""" +
      """"pairing":{"available":true,"url":"orca://pair?code=abc","scope":"mobile"}}"""
    val readiness = OrcadReadinessParser.parse(line)!!
    assertEquals("ws://127.0.0.1:6768", readiness.endpoint)
    assertEquals("orca://pair?code=abc", readiness.pairingUrl)
    assertNull(readiness.pairingUnavailableReason)
  }

  @Test
  fun readinessCarriesTheDesktopWebClientUrlWhenServed() {
    val served = """{"type":"orca_server_ready","endpoint":"ws://127.0.0.1:6768","pairing":{"available":true,"url":"orca://pair?code=m"},""" +
      """"webClientUrl":"http://127.0.0.1:6768/web-index.html#pairing=x"}"""
    assertEquals("http://127.0.0.1:6768/web-index.html#pairing=x", OrcadReadinessParser.parse(served)!!.webClientUrl)
    val notServed = """{"type":"orca_server_ready","endpoint":"ws://127.0.0.1:6768","pairing":{"available":true,"url":"orca://pair?code=m"}}"""
    assertNull(OrcadReadinessParser.parse(notServed)!!.webClientUrl)
  }

  @Test
  fun unavailablePairingReportsItsReason() {
    val line = """{"type":"orca_server_ready","endpoint":null,"pairing":{"available":false,"reason":"disabled_by_operator"}}"""
    val readiness = OrcadReadinessParser.parse(line)!!
    assertNull(readiness.endpoint)
    assertNull(readiness.pairingUrl)
    assertEquals("disabled_by_operator", readiness.pairingUnavailableReason)
  }

  @Test
  fun logLinesAndOtherJsonAreNotReadiness() {
    assertNull(OrcadReadinessParser.parse("[orcad] bound to 127.0.0.1"))
    assertNull(OrcadReadinessParser.parse("""{"event":"startup"}"""))
    assertNull(OrcadReadinessParser.parse("{not json"))
  }

  @Test
  fun androidGroupsMissingFromTheGuestAreAddedOnce() {
    val gids = GuestGroups.parseGroups(listOf("Name:\tapp", "Groups:\t3003 9997 20233 0 "))
    assertEquals(listOf(3003, 9997, 20233, 0), gids)
    val existing = listOf("root:x:0:", "aid_3003:x:3003:")
    assertEquals(listOf("aid_9997:x:9997:", "aid_20233:x:20233:"), GuestGroups.missingEntries(existing, gids))
  }

  @Test
  fun guestTreeIncludesEveryDescendantButNotSiblings() {
    // proot 10 → orcad 11 → daemon 12 → shell 13; 20 is an unrelated process.
    val parents = mapOf(10 to 1, 11 to 10, 12 to 11, 13 to 12, 20 to 1)
    assertEquals(listOf(11, 12, 13), GuestProcessTree.descendants(10, parents))
  }

  @Test
  fun ppidParsingSurvivesSpacesAndParensInTheCommandName() {
    assertEquals(11, GuestProcessTree.parsePpid("12 (bun-runtime) S 11 12 12 0"))
    assertEquals(4, GuestProcessTree.parsePpid("7 (a (weird) name) R 4 7 7 0"))
  }

  @Test
  fun tarEntriesCannotEscapeTheRootfs() {
    val root = File("/r")
    assertEquals(File("/r/usr/bin/env"), TarGzExtractor.resolveInside(root, "./usr/bin/env"))
    assertEquals(File("/r/etc/passwd"), TarGzExtractor.resolveInside(root, "/etc/passwd"))
    assertNull(TarGzExtractor.resolveInside(root, "../outside"))
    assertNull(TarGzExtractor.resolveInside(root, "usr/../../outside"))
    assertNull(TarGzExtractor.resolveInside(root, "./"))
  }
}
