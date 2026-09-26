package android.app

import android.content.Intent

open class Activity {
  var launch: Intent? = null
  var fail = false
  var launches = 0
  fun startActivity(intent: Intent) {
    if (fail) error("injected_launch_denied")
    launch = intent
    launches++
  }
}
