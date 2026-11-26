// Imported first by orcad's entries (esbuild runs it first); the built Electron main and daemon drop
// the same keys from their banner (config/build-plugins/inherited-orca-identity-banner.ts).
import { dropInheritedOrcaIdentityEnv } from './inherited-orca-identity-env'

dropInheritedOrcaIdentityEnv()
