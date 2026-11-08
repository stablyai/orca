import { uiText } from '../settings/NativeUi';
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

/** 通知偏好在每次发布前检查；免打扰立即暂停本机通知。 */

@Entry
@Component
struct NotificationSettings {
  @StorageProp('uiLocale') uiLocale: string = 'en';
  @StorageProp('themeBg') themeBg: string = '#0a0a0a';
  @StorageProp('themeSurface') themeSurface: string = '#171717';
  @StorageProp('themeBorder') themeBorder: string = 'rgba(255, 255, 255, 0.07)';
  @StorageProp('themeText') themeText: string = '#fafafa';
  @StorageProp('themeMuted') themeMuted: string = '#898989';
  @StorageProp('themeSecondary') themeSecondary: string = '#acacac';
  @StorageProp('themeAccent') themeAccent: string = '#3276f2';
  @StorageProp('themeLink') themeLink: string = '#3276f2';
  @StorageProp('themeWarning') themeWarning: string = '#eab308';
  @State delivery: NotificationDeliveryPreferences = { onlyWhenDesktopAway: true, onlyWhenAgentNeedsInput: false, sound: true, suppressWhileViewing: true };
  @State testStatus: string = '';
  @State permission: string = '正在读取';
  @State error: string = '';
  @State saving: boolean = false;
  @State localEnabled: boolean = true;
  @State dndEnabled: boolean = false;

  onPageShow(): void { this.refreshPermission(); }
  private async refreshPermission(): Promise<void> {
    try { this.permission = await notificationManager.isNotificationEnabled() ? '已允许' : '未允许'; }
    catch (e) { this.permission = '无法读取'; }
  }
  private async requestPermission(): Promise<void> {
    try {
      await notificationManager.requestEnableNotification(getContext(this) as common.UIAbilityContext);
      await this.refreshPermission();
    } catch (e) { this.error = '系统未允许通知，可在通知设置中开启'; await this.refreshPermission(); }
  }
  private async openSystemSettings(): Promise<void> {
    try { await notificationManager.openNotificationSettings(getContext(this) as common.UIAbilityContext); await this.refreshPermission(); }
    catch (e) { this.error = '无法打开系统通知设置'; }
  }

  aboutToAppear(): void {
    this.refreshPermission();
    let ctx = getContext(this);
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

  async toggleLocal(isOn: boolean): Promise<void> {
    if (this.saving) { return; } this.saving = true; this.error = '';
    try {
      if (isOn && !await notificationManager.isNotificationEnabled()) { await this.requestPermission(); }
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

  private deliveryValue(key: string): boolean {
    if (key === 'onlyWhenDesktopAway') { return this.delivery.onlyWhenDesktopAway; }
    if (key === 'onlyWhenAgentNeedsInput') { return this.delivery.onlyWhenAgentNeedsInput; }
    if (key === 'sound') { return this.delivery.sound; }
    return this.delivery.suppressWhileViewing;
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
      if (!await notificationManager.isNotificationEnabled()) { await this.requestPermission(); }
      let notifier = new LocalNotifier();
      this.testStatus = await notifier.displayTest(context) ? '测试通知已交给系统显示' : '系统未允许通知，请检查通知权限';
    } catch (e) { this.error = '测试通知发送失败，请检查系统通知设置'; }
  }

  @Builder
  private deliveryRow(key: string, label: string, hint: string) {
    Row({ space: 12 }) {
      Column({ space: 4 }) { Text(label).fontFamily('Geist').fontSize(14).fontColor(this.themeText); Text(hint).fontFamily('Geist').fontSize(12).fontColor(this.themeMuted) }.alignItems(HorizontalAlign.Start).layoutWeight(1)
      Toggle({ type: ToggleType.Switch, isOn: this.deliveryValue(key) }).selectedColor(this.themeAccent).enabled(!this.saving)
        .accessibilityText(label).onChange((on: boolean): void => { this.toggleDelivery(key, on); })
    }.width('100%').padding(14).backgroundColor(this.themeSurface)
  }

  build() {
    Column({ space: 10 }) {
      Row({ space: 10 }) {
        Text('‹')
          .fontFamily('Geist').fontSize(22)
          .fontColor(this.themeAccent)
          .width(32)
          .height(32)
          .textAlign(TextAlign.Center)
          .onClick(() => {
            router.back();
          })
        Text(uiText('通知', this.uiLocale))
          .fontFamily('Geist').fontSize(20)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.themeText)
          .layoutWeight(1)
      }
      .width('100%')
      .padding({ left: 10, right: 14, top: 10 })

      if (this.error.length > 0) { Text(this.error).fontFamily('Geist').fontSize(13).fontColor(this.themeText).padding(12) }
      List({ space: 14 }) {
        ListItem() {
          Column({ space: 8 }) {
            Text(`系统通知权限：${this.permission}`).fontFamily('Geist').fontSize(14).fontColor(this.themeText).width('100%')
            Button(uiText('请求通知权限', this.uiLocale)).backgroundColor(this.themeAccent).fontColor('#ffffff').onClick((): void => { this.requestPermission(); })
            Button(uiText('系统通知设置', this.uiLocale)).backgroundColor(Color.Transparent).fontColor(this.themeText).onClick((): void => { this.openSystemSettings(); })
            Button(uiText('发送本地展示测试', this.uiLocale)).fontColor(this.themeText).backgroundColor(Color.Transparent).onClick((): void => { this.displayTest(); })
            if (this.testStatus.length > 0) { Text(this.testStatus).fontFamily('Geist').fontSize(12).fontColor(this.themeMuted).width('100%') }
            Text(uiText('远程后台推送暂不可用：Orca 官方网关尚未支持 HarmonyOS Push。本地提醒需要应用保持连接。', this.uiLocale)).fontFamily('Geist').fontSize(12).fontColor(this.themeMuted).width('100%')
          }.width('100%').padding(14).backgroundColor(this.themeSurface).borderRadius(12)
        }
        ListItem() {
          Column() {
            this.deliveryRow('onlyWhenDesktopAway', '仅在离开电脑时提醒', '桌面报告 3 分钟无键鼠活动或锁定时才提醒')
            this.deliveryRow('onlyWhenAgentNeedsInput', '仅在 Agent 需要我时提醒', '保留权限请求和问题，跳过 Agent 完成通知')
            this.deliveryRow('sound', '通知声音', '关闭后通知静音；系统通知设置仍有最终控制权')
            this.deliveryRow('suppressWhileViewing', '查看时不提醒', '跳过正在此手机查看的同一工作区通知')
          }.width('100%').borderRadius(12).clip(true)
        }
        // 本地通知开关
        ListItem() {
          Column({ space: 8 }) {
            Text(uiText('本地通知', this.uiLocale))
              .fontFamily('Geist').fontSize(12)
              .fontColor(this.themeMuted)
              .width('100%')
              .padding({ left: 4 })
            Row({ space: 10 }) {
              Column({ space: 3 }) {
                Text(uiText('启用本地通知', this.uiLocale))
                  .fontFamily('Geist').fontSize(15)
                  .fontColor(this.themeText)
                Text(uiText('应用保持连接时，在系统通知栏显示桌面事件', this.uiLocale))
                  .fontFamily('Geist').fontSize(11)
                  .fontColor(this.themeMuted)
              }
              .alignItems(HorizontalAlign.Start)
              .layoutWeight(1)

              Toggle({ type: ToggleType.Switch, isOn: this.localEnabled })
                .selectedColor(this.themeAccent)
                .enabled(!this.saving)
                .onChange((isOn: boolean) => {
                  this.toggleLocal(isOn);
                })
            }
            .width('100%')
            .padding(14)
            .borderRadius(12)
            .backgroundColor(this.themeSurface)
            .border({ width: 1, color: this.themeBorder })
          }
          .width('100%')
        }

        // 免打扰开关
        ListItem() {
          Column({ space: 8 }) {
            Text(uiText('免打扰', this.uiLocale))
              .fontFamily('Geist').fontSize(12)
              .fontColor(this.themeMuted)
              .width('100%')
              .padding({ left: 4 })
            Row({ space: 10 }) {
              Column({ space: 3 }) {
                Text(uiText('启用免打扰', this.uiLocale))
                  .fontFamily('Geist').fontSize(15)
                  .fontColor(this.themeText)
                Text(uiText('开启后暂停本地会话通知，关闭后恢复', this.uiLocale))
                  .fontFamily('Geist').fontSize(11)
                  .fontColor(this.themeMuted)
              }
              .alignItems(HorizontalAlign.Start)
              .layoutWeight(1)

              Toggle({ type: ToggleType.Switch, isOn: this.dndEnabled })
                .selectedColor(this.themeAccent)
                .enabled(!this.saving)
                .onChange((isOn: boolean) => {
                  this.toggleDnd(isOn);
                })
            }
            .width('100%')
            .padding(14)
            .borderRadius(12)
            .backgroundColor(this.themeSurface)
            .border({ width: 1, color: this.themeBorder })

            Text(uiText('免打扰立即控制本机通知；不影响桌面端的通知配置。', this.uiLocale))
              .fontFamily('Geist').fontSize(11)
              .fontColor(this.themeMuted)
              .lineHeight(17)
              .width('100%')
              .padding({ left: 4, right: 4 })
          }
          .width('100%')
        }
      }
      .layoutWeight(1)
      .width('100%')
      .padding({ left: 12, right: 12 })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.themeBg)
  }
}
