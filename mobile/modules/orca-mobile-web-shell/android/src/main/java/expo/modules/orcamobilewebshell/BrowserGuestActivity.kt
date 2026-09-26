package expo.modules.orcamobilewebshell

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/** Presentation borrows the service's page; leaving it never destroys the document. */
@androidx.annotation.RequiresApi(28)
class BrowserGuestActivity : Activity() {
  private var guest: BrowserGuestService? = null

  override fun onCreate(state: Bundle?) {
    super.onCreate(state)
    try {
      check(BuildConfig.BROWSER_FIXTURE) { "native_browser_admission_disabled" }
      val page = BrowserGuestService.current ?: error("guest_unavailable")
      guest = page
    } catch (_: Exception) { finish() }
  }

  override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent) }
  override fun onResume() {
    super.onResume()
    try {
      // Android can restore the old task before delivering the explicit presentation intent.
      guest?.attach(this, intent.getStringExtra("generation") ?: error("generation_required"))
      guest?.foreground(this, true)
    } catch (_: Exception) { finish() }
  }
  override fun onStop() { guest?.detach(this); super.onStop() }
  override fun onPause() { guest?.foreground(this, false); super.onPause() }
  override fun onDestroy() { guest?.detach(this); guest = null; super.onDestroy() }
}
