package expo.modules.orcamobilewebshell

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import java.util.UUID
import java.util.concurrent.CompletableFuture

/** Keeps this module’s shell runtime available for its native page commands. */
internal class BrowserGuestReactTask(context: ReactContext, private val generation: String) {
  private val tasks = HeadlessJsTaskContext.getInstance(context)
  private class Run(val token: String = UUID.randomUUID().toString()) {
    var id: Int? = null
    val ended = CompletableFuture<String>()
  }
  private var current: Run? = null

  fun start() {
    if (current != null) return
    val run = Run()
    current = run
    try {
      run.id = tasks.startTask(HeadlessJsTaskConfig("OrcaBrowserGuest", Arguments.createMap().apply {
        putString("generation", generation)
        putString("taskToken", run.token)
      }, 0, true))
    } catch (error: Exception) { stop(); throw error }
  }

  fun waitForStop(token: String): CompletableFuture<String> {
    val run = current
    return if (run != null && run.token == token) run.ended else CompletableFuture.completedFuture("{}")
  }

  fun stop() {
    val run = current ?: return
    current = null
    run.ended.complete("{}")
    run.id?.let { tasks.finishTask(it) }
  }
}
