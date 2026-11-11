// What signing out clears of the sleeping-workspace read path: this profile's reader key and pins.
import { clearCloudReadPins } from './cloud-read-pin-store'
import { clearCloudReaderKey } from './cloud-reader-key-store'

export { revokeCloudReaderKeyBestEffort } from './cloud-reader-key-store'

export async function clearCloudReadState(profileId: string, userDataPath: string): Promise<void> {
  await clearCloudReaderKey(profileId, userDataPath)
  await clearCloudReadPins(profileId, userDataPath)
}
