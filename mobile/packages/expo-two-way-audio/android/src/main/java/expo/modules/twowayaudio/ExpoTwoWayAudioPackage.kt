package expo.modules.twowayaudio

import android.content.Context
import expo.modules.core.interfaces.Package
import expo.modules.core.interfaces.ReactActivityLifecycleListener

class ExpoTwoWayAudioPackage : Package {
    override fun createReactActivityLifecycleListeners(activityContext: Context): List<ReactActivityLifecycleListener> {
        return listOf(ExpoTwoWayAudioLifeCycleListener())
    }
}