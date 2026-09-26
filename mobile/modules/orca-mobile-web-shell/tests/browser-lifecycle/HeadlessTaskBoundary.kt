package com.facebook.react.jstasks

import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.WritableMap

class HeadlessJsTaskConfig(val key: String, val data: WritableMap, val timeout: Int, val allowed: Boolean)
class HeadlessJsTaskContext {
  var fail = false
  val active = mutableSetOf<Int>()
  var last: HeadlessJsTaskConfig? = null
  private var next = 0
  fun startTask(config: HeadlessJsTaskConfig): Int {
    check(!fail) { "react_task_unavailable" }
    last = config
    val id = ++next
    active.add(id)
    return id
  }
  fun finishTask(id: Int) { check(active.remove(id)) { "Task already finished" } }
  companion object {
    val instance = HeadlessJsTaskContext()
    fun getInstance(context: ReactContext) = instance
  }
}
