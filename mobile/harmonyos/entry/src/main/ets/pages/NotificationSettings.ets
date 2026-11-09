import { uiText } from '../settings/NativeUi';
import { lucideColorFilter } from '../settings/LucideColor';
import { SettingsNavBar } from '../settings/SettingsNavBar';
import { LocalNotifier } from '../notifications/LocalNotifier';
import { NotificationPermissionState, openNotificationPermissionSettings, readNotificationPermission,
  requestNotificationPermission } from '../notifications/NotificationPermission';
import { common } from '@kit.AbilityKit';
import { router } from '@kit.ArkUI';
import {
  getBool,
  setBool,
  KEY_NOTIFICATIONS_LOCAL_ENABLED,
  KEY_NOTIFICATIONS_DND_ENABLED,
  NotificationDeliveryPreferences, notificationDeliveryPreferences, saveNotificationDeliveryPreferences
} from '../settings/SettingsStore';

@Entry
@Component
struct NotificationSettings {
  @StorageProp('uiLocale') uiLocale: string = 'en';
  @StorageProp('themeBg') themeBg: string = '#0a0a0a';
  @StorageProp('themeSurface') themeSurface: string = '#171717';
  @StorageProp('themeBorder') themeBorder: string = 'rgba(255, 255, 255, 0.07)';
  @StorageProp('themeText') themeText: string = '#fafafa';
  @StorageProp('themeSecondary') themeSecondary: string = '#acacac';
  @StorageProp('themeAccent') themeAccent: string = '#3276f2';
  @StorageProp('themeStatusRed') themeStatusRed: string = '#ff6568';
  @State delivery: NotificationDeliveryPreferences = { onlyWhenDesktopAway: true, onlyWhenAgentNeedsInput: false, sound: true, suppressWhileViewing: true };
  @State testStatus: string = '';
  @State permission: NotificationPermissionState | '' = '';
  @State error: string = '';
  @State saving: boolean = false;
  @State testing: boolean = false;
  @State localEnabled: boolean = false;
  @State dndEnabled: boolean = false;

  private visible: boolean = false;
  private revision: number = 0;
  private readonly refreshOnForeground = (): void => { this.refreshPermission().catch(() => {}); };

  onPageShow(): void { this.visible = true; this.refreshOnForeground(); }
  onPageHide(): void { this.visible = false; this.revision++; }

  private async refreshPermission(): Promise<void> {
    if (!this.visible || this.saving) { return; }
    let revision = ++this.revision;
    let context = getContext(this) as common.UIAbilityContext;
    try {
      let permission = await readNotificationPermission(context);
      let enabled = await getBool(context, KEY_NOTIFICATIONS_LOCAL_ENABLED);
      if (revision === this.revision) { this.permission = permission; this.localEnabled = enabled; }
    } catch (e) {
      if (revision === this.revision) { this.error = 'settings.notificationSettingsScreen.loadFailed'; }
    }
  }

  private async openSystemSettings(): Promise<void> {
    if (this.saving) { return; }
    this.saving = true; this.error = '';
    let revision = ++this.revision;
    try {
      let permission = await openNotificationPermissionSettings(getContext(this) as common.UIAbilityContext);
      if (revision === this.revision) { this.permission = permission; }
    } catch (e) {
      if (revision === this.revision) { this.error = 'settings.notificationSettingsScreen.openSettingsFailed'; }
    } finally {
      this.saving = false;
      if (revision !== this.revision) { this.refreshOnForeground(); }
    }
  }

  aboutToAppear(): void {
    let ctx = getContext(this) as common.UIAbilityContext;
    ctx.eventHub.on('orcaForeground', this.refreshOnForeground);
    try { this.delivery = notificationDeliveryPreferences(ctx); } catch (e) { this.error = '无法读取通知筛选设置'; }
    getBool(ctx, KEY_NOTIFICATIONS_DND_ENABLED).then((v: boolean) => {
      this.dndEnabled = v;
    }).catch((e: Error) => {
      // 读取失败保持默认关闭
    });
  }

  aboutToDisappear(): void {
    this.onPageHide();
    (getContext(this) as common.UIAbilityContext).eventHub.off('orcaForeground', this.refreshOnForeground);
  }

  async toggleLocal(isOn: boolean): Promise<void> {
    if (this.saving || this.permission === 'denied') { return; }
    this.saving = true; this.error = '';
    let revision = ++this.revision;
    let context = getContext(this) as common.UIAbilityContext;
    try {
      let permission = isOn ? await requestNotificationPermission(context) : await readNotificationPermission(context);
      let enabled = isOn && permission === 'granted';
      await setBool(context, KEY_NOTIFICATIONS_LOCAL_ENABLED, enabled);
      this.localEnabled = enabled;
      if (revision === this.revision) { this.permission = permission; }
    } catch (e) {
      if (revision === this.revision) { this.error = 'settings.notificationSettingsScreen.saveFailed'; }
    } finally {
      this.saving = false;
      if (revision !== this.revision) { this.refreshOnForeground(); }
    }
  }

  async toggleDnd(isOn: boolean): Promise<void> {
    if (this.saving) { return; } this.saving = true; this.error = '';
    try { await setBool(getContext(this), KEY_NOTIFICATIONS_DND_ENABLED, isOn); this.dndEnabled = isOn; }
    catch (e) { this.error = '无法保存免打扰设置，请重试'; }
    finally { this.saving = false; }
  }

  private switchValue(key: string): boolean {
    if (key === 'enabled') { return this.localEnabled && this.permission === 'granted'; }
    if (key === 'dnd') { return this.dndEnabled; }
    if (key === 'onlyWhenDesktopAway') { return this.delivery.onlyWhenDesktopAway; }
    if (key === 'onlyWhenAgentNeedsInput') { return this.delivery.onlyWhenAgentNeedsInput; }
    if (key === 'sound') { return this.delivery.sound; }
    return this.delivery.suppressWhileViewing;
  }

  private switchAvailable(key: string): boolean {
    if (key === 'enabled') { return this.permission !== '' && this.permission !== 'denied'; }
    if (key === 'dnd') { return this.localEnabled || this.dndEnabled; }
    return this.localEnabled && this.permission === 'granted';
  }

  private async toggleDelivery(key: string, on: boolean): Promise<void> {
    if (this.saving) { return; } this.saving = true; this.error = '';
    let value: NotificationDeliveryPreferences = { onlyWhenDesktopAway: this.delivery.onlyWhenDesktopAway,
      onlyWhenAgentNeedsInput: this.delivery.onlyWhenAgentNeedsInput, sound: this.delivery.sound,
      suppressWhileViewing: this.delivery.suppressWhileViewing };
    if (key === 'onlyWhenDesktopAway') { value.onlyWhenDesktopAway = on; }
    if (key === 'onlyWhenAgentNeedsInput') { value.onlyWhenAgentNeedsInput = on; }
    if (key === 'sound') { value.sound = on; }
    if (key === 'suppressWhileViewing') { value.suppressWhileViewing = on; }
    try { await saveNotificationDeliveryPreferences(getContext(this), value); this.delivery = value; }
    catch (e) { this.error = '无法保存通知筛选设置，请重试'; }
    finally { this.saving = false; }
  }

  private async displayTest(): Promise<void> {
    if (this.testing || this.saving) { return; }
    this.testing = true; this.testStatus = ''; this.error = '';
    let context = getContext(this) as common.UIAbilityContext;
    try {
      if (!this.localEnabled) { this.testStatus = 'settings.notificationDisplayTest.disabled'; return; }
      if (await readNotificationPermission(context) !== 'granted') {
        this.testStatus = 'settings.notificationDisplayTest.osDisabled'; return;
      }
      let published = await new LocalNotifier().displayTest(context, this.t('settings.notificationDisplayTest.localTitle'),
        this.t('settings.notificationDisplayTest.localBody'));
      this.testStatus = published ? '测试通知已交给系统显示' : 'settings.notificationDisplayTest.sendFailed';
    } catch (e) { this.testStatus = 'settings.notificationDisplayTest.sendFailed'; }
    finally { this.testing = false; }
  }

  private t(label: string): string { return uiText(label, this.uiLocale); }

  @Builder
  private switchRow(key: string, label: string, hint: string = '') {
    Row({ space: 12 }) {
      Column({ space: 4 }) {
        Text(this.t(label)).fontFamily('Geist').fontSize(15).fontColor(this.themeText)
        if (hint) { Text(this.t(hint)).fontFamily('Geist').fontSize(13).fontColor(this.themeSecondary) }
      }.alignItems(HorizontalAlign.Start).layoutWeight(1)
      Toggle({ type: ToggleType.Switch, isOn: this.switchValue(key) }).selectedColor(this.themeAccent)
        .width(51).height(31).switchPointColor(Color.White)
        .enabled(this.switchAvailable(key) && !this.saving).accessibilityText(this.t(label)).id(`notification-${key}`)
        .onChange((on: boolean): void => {
          if (key === 'enabled') { this.toggleLocal(on); }
          else if (key === 'dnd') { this.toggleDnd(on); }
          else { this.toggleDelivery(key, on); }
        })
    }.width('100%').constraintSize({ minHeight: 52 }).padding(16).opacity(this.switchAvailable(key) ? 1 : 0.5)
  }

  @Builder
  private separator() {
    Row().width('100%').height(0.5).backgroundColor(this.themeBorder).margin({ left: 16 })
  }

  @Builder
  private note(label: string, error: boolean = false) {
    Text(this.t(label)).fontFamily('Geist').fontSize(13).lineHeight(18)
      .fontColor(error ? this.themeStatusRed : this.themeSecondary).width('100%').padding({ top: 8, left: 16, right: 16 })
  }

  @Builder
  private actionRow(label: string, key: string, navigate: boolean, enabled: boolean, action: () => void) {
    Button({ type: ButtonType.Normal }) {
      Row({ space: 8 }) {
        Text(this.t(label)).fontFamily('Geist').fontSize(15).fontColor(this.themeText).layoutWeight(1)
        if (navigate) {
          Image($r('app.media.lucide_chevron_right')).supportSvg2(true).width(16).height(16)
            .colorFilter(lucideColorFilter(this.themeSecondary))
        }
      }.width('100%').padding({ left: 16, right: 16, top: 12, bottom: 12 })
    }.width('100%').constraintSize({ minHeight: 48 }).backgroundColor(Color.Transparent).enabled(enabled)
      .id(key).accessibilityText(this.t(label)).onClick(action)
  }

  build() {
    Column() {
      SettingsNavBar({ title: this.t('通知') })

      Scroll() {
        Column({ space: 16 }) {
          if (this.error) { this.note(this.error, true) }
          Column() {
            Column() {
              if (this.permission === 'denied') {
                this.switchRow('enabled', '启用通知')
                this.separator()
                this.actionRow('打开设置', 'notification-system-settings', false, !this.saving,
                  (): void => { this.openSystemSettings().catch(() => {}); })
              } else { this.switchRow('enabled', '启用通知') }
            }.width('100%').backgroundColor(this.themeSurface).borderRadius(16).clip(true)
            if (this.permission === 'denied') { this.note('系统设置中的通知已关闭。') }
            else { this.note('应用保持连接时，在系统通知栏显示桌面事件') }
          }.width('100%')

          Column() {
            Column() {
              this.switchRow('onlyWhenDesktopAway', '仅在离开桌面时', '键盘和鼠标均无操作达 3 分钟后，或锁屏时。')
              this.separator()
              this.switchRow('onlyWhenAgentNeedsInput', '仅在智能体需要我时', '保留权限请求和问题，跳过 Agent 完成通知')
              this.separator()
              this.switchRow('sound', '通知声音')
              this.separator()
              this.switchRow('suppressWhileViewing', '查看时不提醒', '不发送此手机上当前打开的工作区的提醒。')
            }.width('100%').backgroundColor(this.themeSurface).borderRadius(16).clip(true)
            this.note('提醒类型遵循各个已配对桌面的通知设置。')
          }.width('100%')

          Column() {
            Text(this.t('settings.notificationDisplayTest.troubleReceivingAlerts')).fontFamily('Geist').fontSize(13)
              .fontColor(this.themeSecondary).width('100%').padding({ left: 16, bottom: 8 })
            Column() {
              if (this.testing) {
                this.actionRow('settings.notificationDisplayTest.sending', 'notification-display-test', false, false, (): void => {})
              } else {
                this.actionRow('发送本地展示测试', 'notification-display-test', false, !this.saving,
                  (): void => { this.displayTest().catch(() => {}); })
              }
              this.separator()
              this.actionRow('settings.notificationDisplayTest.troubleshooting', 'notification-troubleshoot', true, true,
                (): void => { router.pushUrl({ url: 'pages/Troubleshoot' }).catch(() => {}); })
            }.width('100%').backgroundColor(this.themeSurface).borderRadius(16).clip(true)
            this.note('远程后台推送暂不可用：Orca 官方网关尚未支持 HarmonyOS Push。本地提醒需要应用保持连接。')
            if (this.testStatus) { this.note(this.testStatus) }
          }.width('100%')
          Column() {
            this.switchRow('dnd', '免打扰', '开启后暂停本地会话通知，关闭后恢复')
          }.width('100%').backgroundColor(this.themeSurface).borderRadius(16).clip(true)
        }.width('100%').padding({ top: 8, left: 16, right: 16, bottom: 24 })
      }.width('100%').layoutWeight(1).scrollBar(BarState.Off).align(Alignment.Top)
    }.width('100%').height('100%').backgroundColor(this.themeBg)
  }
}
