import { uiText } from '../settings/NativeUi';
import { lucideColorFilter } from '../settings/LucideColor';
import { LocalNotifier } from '../notifications/LocalNotifier';
import { notificationManager } from '@kit.NotificationKit';
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
  @State delivery: NotificationDeliveryPreferences = { onlyWhenDesktopAway: true, onlyWhenAgentNeedsInput: false, sound: true, suppressWhileViewing: true };
  @State testStatus: string = '';
  @State permissionAllowed: boolean = false;
  @State permissionLoaded: boolean = false;
  @State error: string = '';
  @State saving: boolean = false;
  @State localEnabled: boolean = true;
  @State dndEnabled: boolean = false;

  private readonly refreshOnForeground = (): void => { this.refreshPermission().catch(() => {}); };

  onPageShow(): void { this.refreshOnForeground(); }

  private async refreshPermission(): Promise<boolean> {
    try { this.permissionAllowed = await notificationManager.isNotificationEnabled(); }
    catch (e) { this.permissionAllowed = false; }
    this.permissionLoaded = true;
    return this.permissionAllowed;
  }

  private async requestPermission(): Promise<boolean> {
    try { await notificationManager.requestEnableNotification(getContext(this) as common.UIAbilityContext); }
    catch (e) {}
    return this.refreshPermission();
  }

  private async openSystemSettings(): Promise<void> {
    try { await notificationManager.openNotificationSettings(getContext(this) as common.UIAbilityContext); await this.refreshPermission(); }
    catch (e) { this.error = '无法打开系统通知设置'; }
  }

  aboutToAppear(): void {
    let ctx = getContext(this) as common.UIAbilityContext;
    ctx.eventHub.on('orcaForeground', this.refreshOnForeground);
    try { this.delivery = notificationDeliveryPreferences(ctx); } catch (e) { this.error = '无法读取通知筛选设置'; }
    getBool(ctx, KEY_NOTIFICATIONS_LOCAL_ENABLED).then((v: boolean) => {
      this.localEnabled = v;
    }).catch((e: Error) => {
      // 读取失败保持默认开启
    });
    getBool(ctx, KEY_NOTIFICATIONS_DND_ENABLED).then((v: boolean) => {
      this.dndEnabled = v;
    }).catch((e: Error) => {
      // 读取失败保持默认关闭
    });
  }

  aboutToDisappear(): void {
    (getContext(this) as common.UIAbilityContext).eventHub.off('orcaForeground', this.refreshOnForeground);
  }

  async toggleLocal(isOn: boolean): Promise<void> {
    if (this.saving) { return; } this.saving = true; this.error = '';
    try {
      if (isOn && !await this.refreshPermission() && !await this.requestPermission()) { return; }
      await setBool(getContext(this), KEY_NOTIFICATIONS_LOCAL_ENABLED, isOn); this.localEnabled = isOn;
    } catch (e) { this.error = '无法保存通知设置，请重试'; }
    finally { this.saving = false; }
  }

  async toggleDnd(isOn: boolean): Promise<void> {
    if (this.saving) { return; } this.saving = true; this.error = '';
    try { await setBool(getContext(this), KEY_NOTIFICATIONS_DND_ENABLED, isOn); this.dndEnabled = isOn; }
    catch (e) { this.error = '无法保存免打扰设置，请重试'; }
    finally { this.saving = false; }
  }

  private switchValue(key: string): boolean {
    if (key === 'enabled') { return this.localEnabled && this.permissionAllowed; }
    if (key === 'dnd') { return this.dndEnabled; }
    if (key === 'onlyWhenDesktopAway') { return this.delivery.onlyWhenDesktopAway; }
    if (key === 'onlyWhenAgentNeedsInput') { return this.delivery.onlyWhenAgentNeedsInput; }
    if (key === 'sound') { return this.delivery.sound; }
    return this.delivery.suppressWhileViewing;
  }

  private switchAvailable(key: string): boolean {
    if (key === 'enabled') { return this.permissionLoaded; }
    if (key === 'dnd') { return this.localEnabled || this.dndEnabled; }
    return this.localEnabled && this.permissionAllowed;
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
    this.testStatus = ''; this.error = '';
    try {
      let context = getContext(this) as common.UIAbilityContext;
      if (!await this.refreshPermission()) { return; }
      let notifier = new LocalNotifier();
      this.testStatus = await notifier.displayTest(context) ? '测试通知已交给系统显示' : '系统未允许通知，请检查通知权限';
    } catch (e) { this.error = '测试通知发送失败，请检查系统通知设置'; }
  }

  @Builder
  private switchRow(key: string, label: string, hint: string = '') {
    Row({ space: 12 }) {
      Column({ space: 4 }) {
        Text(uiText(label, this.uiLocale)).fontFamily('Geist').fontSize(16).fontColor(this.themeText)
        if (hint) { Text(uiText(hint, this.uiLocale)).fontFamily('Geist').fontSize(13).fontColor(this.themeSecondary) }
      }.alignItems(HorizontalAlign.Start).layoutWeight(1)
      Toggle({ type: ToggleType.Switch, isOn: this.switchValue(key) }).selectedColor(this.themeAccent)
        .enabled(this.switchAvailable(key) && !this.saving).accessibilityText(uiText(label, this.uiLocale))
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
  private note(label: string) {
    Text(uiText(label, this.uiLocale)).fontFamily('Geist').fontSize(13).lineHeight(18)
      .fontColor(this.themeSecondary).width('100%').padding({ top: 8, left: 16, right: 16 })
  }

  build() {
    Column() {
      Row() {
        Button({ type: ButtonType.Circle }) {
          Image($r('app.media.lucide_chevron_left')).supportSvg2(true).width(22).height(22)
            .colorFilter(lucideColorFilter(this.themeText))
        }.width(44).height(44).backgroundColor(this.themeSurface)
          .accessibilityText(uiText('返回', this.uiLocale)).onClick(() => router.back())
        Text(uiText('通知', this.uiLocale)).fontFamily('Geist').fontSize(17).fontWeight(FontWeight.Medium)
          .fontColor(this.themeText).layoutWeight(1).textAlign(TextAlign.Center)
        Row().width(44)
      }.width('100%').height(54).padding({ left: 16, right: 16 })

      Scroll() {
        Column({ space: 16 }) {
          if (this.error) { this.note(this.error) }
          Column() {
            Column() {
              this.switchRow('enabled', '启用通知')
              if (this.permissionLoaded && !this.permissionAllowed) {
                this.separator()
                Button(uiText('打开设置', this.uiLocale)).width('100%').height(52).fontFamily('Geist').fontSize(16)
                  .fontColor(this.themeText).backgroundColor(Color.Transparent).onClick(() => { this.openSystemSettings(); })
              }
            }.width('100%').backgroundColor(this.themeSurface).borderRadius(16).clip(true)
            this.note(this.permissionLoaded && !this.permissionAllowed ? '系统设置中的通知已关闭。' : '应用保持连接时，在系统通知栏显示桌面事件')
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
            Column() {
              this.switchRow('dnd', '免打扰', '开启后暂停本地会话通知，关闭后恢复')
              this.separator()
              Button(uiText('发送本地展示测试', this.uiLocale)).width('100%').height(52).fontFamily('Geist').fontSize(16)
                .fontColor(this.themeText).backgroundColor(Color.Transparent).enabled(this.permissionAllowed)
                .onClick(() => { this.displayTest(); })
            }.width('100%').backgroundColor(this.themeSurface).borderRadius(16).clip(true)
            if (this.testStatus) { this.note(this.testStatus) }
            this.note('远程后台推送暂不可用：Orca 官方网关尚未支持 HarmonyOS Push。本地提醒需要应用保持连接。')
          }.width('100%')
        }.width('100%').padding({ top: 8, left: 16, right: 16, bottom: 24 })
      }.width('100%').layoutWeight(1).scrollBar(BarState.Off).align(Alignment.Top)
    }.width('100%').height('100%').backgroundColor(this.themeBg)
  }
}
