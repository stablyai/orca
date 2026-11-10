import { invalidateHomePrewarm } from '../webshell/HomeShellPrewarm';
import { common } from '@kit.AbilityKit';
import { deleteHost, retryPendingHostCredentialCleanup } from './HostStore';
import { forgetDesktopConnection } from '../transport/DesktopConnections';
import { WebBundleFetcher } from '../transport/WebBundleFetcher';

export async function removeDesktop(context: common.Context, hostId: string, onDeleted: () => void): Promise<void> {
  await deleteHost(context, hostId);
  invalidateHomePrewarm(hostId);
  forgetDesktopConnection(hostId);
  WebBundleFetcher.forgetPairedBundle(context, hostId);
  onDeleted();
  retryPendingHostCredentialCleanup(context, hostId).catch(() => {});
}
