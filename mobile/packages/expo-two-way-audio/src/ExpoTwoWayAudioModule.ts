import { requireNativeModule } from 'expo-modules-core'

// Load JSI module, falling back to NativeModulesProxy under remote debugger.
export default requireNativeModule('ExpoTwoWayAudio')
