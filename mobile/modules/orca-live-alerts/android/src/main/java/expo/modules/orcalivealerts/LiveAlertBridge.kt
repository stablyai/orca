package expo.modules.orcalivealerts

import java.lang.ref.WeakReference

/** What the service tells the module: events for JavaScript, and that the service stopped. */
internal interface LiveAlertEventSink {
  fun emit(name: String, body: Map<String, Any?>)

  fun serviceStopped()
}

/**
 * In-process link between [OrcaLiveAlertsModule] and [LiveAgentService], which share the app
 * process. Weak references keep a destroyed React instance or service collectable.
 */
internal object LiveAlertBridge {
  @Volatile private var sinkRef: WeakReference<LiveAlertEventSink>? = null

  @Volatile private var serviceRef: WeakReference<LiveAgentService>? = null

  /** The newest payload the module was asked to show; null once the session finished. */
  @Volatile var latestPayload: LiveAlertPayload? = null

  val service: LiveAgentService?
    get() = serviceRef?.get()

  fun attachSink(sink: LiveAlertEventSink) {
    sinkRef = WeakReference(sink)
  }

  fun detachSink(sink: LiveAlertEventSink) {
    if (sinkRef?.get() === sink) {
      sinkRef = null
    }
  }

  fun attachService(service: LiveAgentService) {
    serviceRef = WeakReference(service)
  }

  // A finished service detaches at once, so a new session starts a fresh instance while the old
  // one is still being destroyed; only the current instance's stop ends the keep-alive.
  fun detachService(service: LiveAgentService) {
    if (serviceRef?.get() !== service) {
      return
    }
    serviceRef = null
    sinkRef?.get()?.serviceStopped()
  }

  fun emit(name: String, body: Map<String, Any?> = emptyMap()) {
    sinkRef?.get()?.emit(name, body)
  }
}
