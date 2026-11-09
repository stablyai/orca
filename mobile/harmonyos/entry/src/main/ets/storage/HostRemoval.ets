import { invalidateHomePrewarm } from '../webshell/HomeShellPrewarm';
import { common } from '@kit.AbilityKit';
import { deleteHost } from './HostStore';
import { deletePageStorage } from './PageStorageStore';
import { forgetDesktopConnection } from '../transport/DesktopConnections';
import { clearHomeResume } from '../home/HomeResume';
import { WebBundleFetcher } from '../transport/WebBundleFetcher';

export async function removeDesktop(context: common.Context, hostId: string, onDeleted: () => void): Promise<void> {
  await deleteHost(context, hostId);
  invalidateHomePrewarm(hostId);
  forgetDesktopConnection(hostId);
  WebBundleFetcher.forgetPairedBundle(context, hostId);
  onDeleted();
  clearHomeResume(context, hostId);
  await deletePageStorage(context, hostId);
}
