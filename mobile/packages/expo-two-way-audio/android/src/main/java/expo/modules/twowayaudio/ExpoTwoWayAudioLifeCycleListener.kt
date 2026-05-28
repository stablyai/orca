package expo.modules.twowayaudio

import android.app.Activity
import expo.modules.core.interfaces.ReactActivityLifecycleListener

class ExpoTwoWayAudioLifeCycleListener : ReactActivityLifecycleListener {
    override fun onPause(activity: Activity?) {
        super.onPause(activity)
        // At the moment background audio recording and playback is not supported
        ExpoTwoWayAudioModule.audioEngine?.pauseRecordingAndPlayer()
    }

    override fun onResume(activity: Activity?) {
        super.onResume(activity)
        // At the moment background audio recording and playback is not supported
        ExpoTwoWayAudioModule.audioEngine?.resumeRecordingAndPlayer()
    }
}
