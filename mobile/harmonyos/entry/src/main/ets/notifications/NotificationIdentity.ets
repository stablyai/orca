export interface NotificationIdentity {
  notificationId: string;
  notificationEpoch: string;
  notificationSeq: number;
}

export function readNotificationIdentity(value: ESObject): NotificationIdentity | null {
  if (!value || typeof value !== 'object') { return null; }
  let id: ESObject = value['notificationId'];
  let epoch: ESObject = value['notificationEpoch'];
  let seq: ESObject = value['notificationSeq'];
  if (typeof id !== 'string' || id.length === 0 || id.length > 2048 || typeof epoch !== 'string'
    || epoch.length === 0 || epoch.length > 128 || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) { return null; }
  return { notificationId: id, notificationEpoch: epoch, notificationSeq: seq };
}

export function notificationFenceKey(value: NotificationIdentity): string {
  return JSON.stringify([value.notificationId, value.notificationEpoch]);
}
