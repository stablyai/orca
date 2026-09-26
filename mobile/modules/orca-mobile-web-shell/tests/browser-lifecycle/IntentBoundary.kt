package android.content

class Intent(activity: android.app.Activity, klass: Class<*>) {
  val extras = mutableMapOf<String, Any>()
  fun addFlags(flags: Int) = this
  fun putExtra(key: String, value: Any) = apply { extras[key] = value }
  companion object { const val FLAG_ACTIVITY_NEW_TASK = 1 }
}
