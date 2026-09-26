package android.app

import android.content.Intent

open class Activity : android.content.Context() {
  val applicationContext: android.content.Context get() = this
  var activityLaunches = 0
  fun startActivity(intent: Intent) {
    if (fail) error("injected_launch_denied")
    activityLaunches++
  }
}
