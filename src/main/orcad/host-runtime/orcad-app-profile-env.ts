// Imported first by the orcad entry: every later module reads the profile's folders.
import { applyAppProfileHomes } from '../../../shared/app-profiles/app-profile-homes'
import { readAppProfileMarker } from '../../../shared/app-profiles/app-profile-paths'
import { resolveUserDataPath } from './orcad-app-paths'

const userDataPath = resolveUserDataPath()
applyAppProfileHomes(readAppProfileMarker(userDataPath) ? userDataPath : null, process.env)
