package expo.modules.orcamobilewebshell

import android.app.Activity
import android.content.Intent
import android.os.*
import java.util.UUID
import java.util.concurrent.CompletableFuture

internal class BrowserGuestOwner {
  companion object { val process = BrowserGuestOwner() }
  private val main = Handler(Looper.getMainLooper())
  private var lease: Lease? = null
  private var sequence = 0
  private class Lease(val generation: String, val open: CompletableFuture<String>, val context: android.content.Context) {
    var connection: android.content.ServiceConnection? = null
    val ended = CompletableFuture<String>()
    var foreground = false
    var resume: CompletableFuture<String>? = null
    var endpoint: Messenger? = null
    var retired = false
    val pending = mutableMapOf<Int, CompletableFuture<String>>()
    var close: CompletableFuture<String>? = null
  }
  private val receiver = Messenger(Handler(Looper.getMainLooper()) { message ->
    val current = lease
    if (current == null || message.data.getString("generation") != current.generation) return@Handler true
    val error = message.data.getString("error")
    if (message.arg1 == -2) {
      current.foreground = message.data.getBoolean("foreground")
      if (current.foreground && !current.retired) {
        current.resume?.complete("{}")
        current.resume = null
      }
    } else if (message.arg1 == -1) {
      val endpoint = message.replyTo
      if (error != null || endpoint == null) {
        current.open.completeExceptionally(IllegalStateException(error ?: "guest_endpoint_missing"))
        retire(current)
      } else {
        current.endpoint = endpoint
        try {
          endpoint.binder.linkToDeath({ main.post { died(current) } }, 0)
          if (current.retired) requestClose(current)
        } catch (error: RemoteException) {
          current.open.completeExceptionally(IllegalStateException("guest_transport_unavailable", error))
          retire(current)
        }
      }
    } else if (message.arg1 == 0) {
      if (error != null) {
        current.open.completeExceptionally(IllegalStateException(error))
        retire(current)
      } else if (!current.retired) current.open.complete(message.data.getString("result") ?: "{}")
    } else {
      val pending = current.pending.remove(message.arg1)
      if (error != null) pending?.completeExceptionally(IllegalStateException(error))
      else pending?.complete(message.data.getString("result") ?: "{}")
    }
    true
  })

  fun open(activity: Activity, route: String): CompletableFuture<String> {
    val result = CompletableFuture<String>()
    main.post {
      try {
        check(BuildConfig.BROWSER_FIXTURE) { "native_browser_admission_disabled" }
        check(Build.VERSION.SDK_INT >= 28) { "native_browser_requires_api_28" }
        BrowserGuestRoute.parse(route)
        check(lease == null) { "guest_process_occupied" }
        val generation = UUID.randomUUID().toString()
        val current = Lease(generation, result, activity.applicationContext)
        lease = current
        try {
          val connection = object : android.content.ServiceConnection {
            override fun onServiceConnected(name: android.content.ComponentName, service: IBinder) {}
            override fun onServiceDisconnected(name: android.content.ComponentName) { unbind(current) }
            override fun onBindingDied(name: android.content.ComponentName) { unbind(current) }
            override fun onNullBinding(name: android.content.ComponentName) { unbind(current) }
          }
          current.connection = connection
          val bound = current.context.bindService(Intent(current.context, BrowserGuestService::class.java).apply {
            putExtra("owner", receiver)
            putExtra("generation", current.generation)
            putExtra("route", route)
          }, connection, android.content.Context.BIND_AUTO_CREATE)
          if (!bound) {
            unbind(current)
            lease = null
            error("guest_bind_failed")
          }
        } catch (error: Exception) {
          result.completeExceptionally(error)
          if (lease === current) retire(current)
          return@post
        }
        main.postDelayed({
          if (!result.isDone && lease === current) {
            result.completeExceptionally(IllegalStateException("guest_open_timeout"))
            retire(current)
          }
        }, 15000)
      } catch (error: Exception) { result.completeExceptionally(error) }
    }
    return result
  }

  fun command(generation: String, request: String): CompletableFuture<String> {
    val result = CompletableFuture<String>()
    main.post {
      try {
        val current = requireLease(generation)
        check(current.pending.isEmpty()) { "guest_busy" }
        require(request.length <= 65536) { "command_too_large" }
        val id = ++sequence
        current.pending[id] = result
        try { send(current, 1, id, request) } catch (error: Exception) {
          current.pending.remove(id)
          throw error
        }
        main.postDelayed({
          if (current.pending.remove(id) != null) {
            result.completeExceptionally(IllegalStateException("guest_command_timeout"))
            retire(current)
          }
        }, 12000)
      } catch (error: Exception) { result.completeExceptionally(error) }
    }
    return result
  }

  fun close(generation: String): CompletableFuture<String> {
    val result = CompletableFuture<String>()
    main.post {
      try {
        val current = requireLease(generation)
        current.close = result
        retire(current)
        main.postDelayed({ result.completeExceptionally(IllegalStateException("guest_close_unconfirmed")) }, 5000)
      } catch (error: Exception) { result.completeExceptionally(error) }
    }
    return result
  }

  fun resume(activity: Activity, generation: String): CompletableFuture<String> {
    val result = CompletableFuture<String>()
    main.post {
      try {
        val current = requireLease(generation)
        check(current.resume == null) { "guest_resume_pending" }
        if (current.foreground) { result.complete("{}"); return@post }
        current.resume = result
        activity.startActivity(Intent(activity, BrowserGuestActivity::class.java).apply {
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          putExtra("generation", generation)
        })
        main.postDelayed({
          if (current.resume === result) {
            current.resume = null
            result.completeExceptionally(IllegalStateException("guest_resume_timeout"))
          }
        }, 5000)
      } catch (error: Exception) {
        if (lease?.resume === result) lease?.resume = null
        result.completeExceptionally(error)
      }
    }
    return result
  }

  fun terminateFixture(generation: String): CompletableFuture<String> {
    val result = CompletableFuture<String>()
    main.post {
      try {
        check(BuildConfig.BROWSER_FIXTURE) { "native_browser_admission_disabled" }
        send(requireLease(generation), 3, 0, "")
        result.complete("{}")
      } catch (error: Exception) { result.completeExceptionally(error) }
    }
    return result
  }

  fun whenEnded(generation: String): CompletableFuture<String> {
    val result = CompletableFuture<String>()
    main.post {
      val current = lease
      if (current == null || current.generation != generation) result.complete("{}")
      else current.ended.whenComplete { value, _ -> result.complete(value) }
    }
    return result
  }

  fun checkActiveGeneration(generation: String) {
    check(Looper.myLooper() == Looper.getMainLooper()) { "main_thread_required" }
    requireLease(generation)
  }

  private fun requireLease(generation: String): Lease {
    val current = lease ?: error("guest_unavailable")
    check(current.generation == generation && !current.retired) { "stale_guest_generation" }
    check(current.endpoint != null) { "guest_not_ready" }
    return current
  }

  private fun retire(current: Lease) {
    if (current.retired) return
    current.retired = true
    current.ended.complete("{}")
    current.open.completeExceptionally(IllegalStateException("guest_closed"))
    current.resume?.completeExceptionally(IllegalStateException("guest_closed"))
    current.resume = null
    current.pending.values.forEach { it.completeExceptionally(IllegalStateException("guest_closed")) }
    current.pending.clear()
    requestClose(current)
  }

  private fun requestClose(current: Lease) {
    try { current.endpoint?.let { send(current, 2, 0, "") } } catch (error: Exception) {
      current.close?.completeExceptionally(error)
    }
  }

  private fun send(current: Lease, operation: Int, id: Int, request: String) {
    try {
      current.endpoint?.send(Message.obtain().apply {
        what = operation; arg1 = id
        data = Bundle().apply { putString("generation", current.generation); putString("request", request) }
      })
    } catch (error: RemoteException) {
      // A failed transaction can have taken effect; only the death recipient frees the lease.
      throw IllegalStateException("guest_transport_unavailable", error)
    }
  }

  private fun unbind(current: Lease) {
    val connection = current.connection ?: return
    current.connection = null
    try { current.context.unbindService(connection) } catch (_: IllegalArgumentException) {
      // Binding may have failed before Android registered the connection.
    }
  }

  private fun died(current: Lease) {
    current.ended.complete("{}")
    current.resume?.completeExceptionally(IllegalStateException("guest_process_exited"))
    current.open.completeExceptionally(IllegalStateException("guest_process_exited"))
    current.pending.values.forEach { it.completeExceptionally(IllegalStateException("guest_process_exited")) }
    current.pending.clear()
    current.close?.complete("{}")
    unbind(current)
    if (lease === current) lease = null
  }
}
