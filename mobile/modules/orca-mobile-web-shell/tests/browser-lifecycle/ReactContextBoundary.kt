package com.facebook.react.bridge

class ReactContext
class WritableMap {
  val values = mutableMapOf<String, String>()
  fun putString(key: String, value: String) { values[key] = value }
}
object Arguments { fun createMap() = WritableMap() }
