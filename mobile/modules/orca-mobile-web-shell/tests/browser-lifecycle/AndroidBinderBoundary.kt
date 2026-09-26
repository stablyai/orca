package android.os

open class RemoteException : Exception()
class TransactionTooLargeException : RemoteException()
class DeadObjectException : RemoteException()
object Build { object VERSION { const val SDK_INT = 36 } }
class Looper { companion object { fun getMainLooper() = Looper() } }

object Scheduler {
  private var now = 0L
  private val delayed = mutableListOf<Pair<Long, () -> Unit>>()
  fun later(ms: Long, block: () -> Unit) { delayed.add(now + ms to block) }
  fun advance(ms: Long) {
    val end = now + ms
    while (true) {
      val next = delayed.minByOrNull { it.first } ?: break
      if (next.first > end) break
      delayed.remove(next)
      now = next.first
      next.second()
    }
    now = end
  }
  fun reset() { delayed.clear(); now = 0 }
}

class Handler(looper: Looper, val callback: ((Message) -> Boolean)? = null) {
  fun post(block: () -> Unit): Boolean { block(); return true }
  fun postDelayed(block: () -> Unit, ms: Long): Boolean { Scheduler.later(ms, block); return true }
}

class Bundle {
  private val values = mutableMapOf<String, Any?>()
  fun putString(key: String, value: String?) { values[key] = value }
  fun getString(key: String) = values[key] as? String
  fun putBoolean(key: String, value: Boolean) { values[key] = value }
  fun getBoolean(key: String) = values[key] == true
}

class Binder {
  var alive = true
  var failure: RemoteException? = null
  var linkFailure: RemoteException? = null
  private val deaths = mutableListOf<() -> Unit>()
  fun linkToDeath(action: () -> Unit, flags: Int) {
    linkFailure?.let { throw it }
    deaths.add(action)
  }
  fun die() { alive = false; deaths.forEach { it() } }
}

class Messenger(val handler: Handler) {
  val binder = Binder()
  var sends = 0
  fun send(message: Message) {
    sends++
    binder.failure?.let { throw it }
    handler.callback?.invoke(message)
  }
}

class Message {
  var data = Bundle()
  var arg1 = 0
  var what = 0
  var replyTo: Messenger? = null
  companion object { fun obtain() = Message() }
}
