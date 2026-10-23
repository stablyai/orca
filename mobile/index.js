// Headless notification launches do not mount the router layout.
import './src/notifications/push-background-dismissal'
import { loadPairedE2EENativeBindings } from './src/transport/paired-e2ee-native-bindings'
import { providePairedE2EENativeBindings } from './src/transport/paired-e2ee-native-codec'
import 'expo-router/entry'

// Why here: only the app entry may load native modules; tests and desktop code reach the transport.
providePairedE2EENativeBindings(loadPairedE2EENativeBindings)
