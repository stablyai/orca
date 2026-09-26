package android.content

import android.os.IBinder

open class Context {
  var launch: Intent? = null
  var fail = false
  var accepted = true
  var launches = 0
  var unbinds = 0
  var connection: ServiceConnection? = null
  fun bindService(intent: Intent, service: ServiceConnection, flags: Int): Boolean {
    if (fail) error("injected_launch_denied")
    launch = intent
    launches++
    connection = service
    return accepted
  }
  fun unbindService(service: ServiceConnection) { unbinds++ }
  companion object { const val BIND_AUTO_CREATE = 1 }
}
class ComponentName
interface ServiceConnection {
  fun onServiceConnected(name: ComponentName, service: IBinder)
  fun onServiceDisconnected(name: ComponentName)
  fun onBindingDied(name: ComponentName) {}
  fun onNullBinding(name: ComponentName) {}
}
class Intent(context: Context, klass: Class<*>) {
  val extras = mutableMapOf<String, Any>()
  fun addFlags(flags: Int) = this
  fun putExtra(key: String, value: Any) = apply { extras[key] = value }
  companion object { const val FLAG_ACTIVITY_NEW_TASK = 1 }
}
