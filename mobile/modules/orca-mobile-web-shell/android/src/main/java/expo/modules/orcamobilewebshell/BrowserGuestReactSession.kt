package expo.modules.orcamobilewebshell

import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.ReactContext
import java.util.concurrent.CompletableFuture

/** React tasks belong to a module instance, never to the process-wide native lease. */
internal class BrowserGuestReactSession {
  private val main = Handler(Looper.getMainLooper())
  private var task: BrowserGuestReactTask? = null
  private var generation: String? = null
  private var destroyed = false

  fun start(context: ReactContext, page: String): CompletableFuture<String> {
    val result = CompletableFuture<String>()
    main.post {
      try {
        check(!destroyed) { "react_module_destroyed" }
        BrowserGuestOwner.process.checkActiveGeneration(page)
        if (generation != page) {
          task?.stop()
          generation = page
          task = BrowserGuestReactTask(context, page)
          try { task?.start() } catch (error: Exception) { stop(page); throw error }
          BrowserGuestOwner.process.whenEnded(page).whenComplete { _, _ -> stop(page) }
        }
        result.complete("{}")
      } catch (error: Exception) {
        result.completeExceptionally(error)
      }
    }
    return result
  }

  fun waitForStop(page: String, token: String): CompletableFuture<String> {
    val result = CompletableFuture<String>()
    main.post {
      val current = task
      if (generation != page || current == null) result.complete("{}")
      else current.waitForStop(token).whenComplete { value, _ -> result.complete(value) }
    }
    return result
  }

  private fun stop(page: String) {
    main.post {
      if (generation != page) return@post
      task?.stop()
      task = null
      generation = null
    }
  }

  fun destroy() {
    main.post {
      destroyed = true
      task?.stop()
      task = null
      generation = null
    }
  }
}
