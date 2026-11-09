import { common } from '@kit.AbilityKit';
import { deleteHost } from './HostStore';
import { deletePageStorage } from './PageStorageStore';
import { clearHomeResume } from '../home/HomeResume';

export async function removeDesktop(context: common.Context, hostId: string, onDeleted: () => void): Promise<void> {
  await deleteHost(context, hostId);
  onDeleted();
  clearHomeResume(context, hostId);
  await deletePageStorage(context, hostId);
}
