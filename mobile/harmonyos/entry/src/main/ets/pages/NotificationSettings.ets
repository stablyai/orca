import { router } from '@kit.ArkUI';
import {
  getBool,
  setBool,
  KEY_NOTIFICATIONS_LOCAL_ENABLED,
  KEY_NOTIFICATIONS_DND_ENABLED
} from '../settings/SettingsStore';

/** 通知偏好在每次发布前检查；免打扰立即暂停本机通知。 */

@Entry
@Component
struct NotificationSettings {
  @StorageProp('themeBg') themeBg: string = '#111111';
  @StorageProp('themeSurface') themeSurface: string = '#1c1c1c';
  @StorageProp('themeBorder') themeBorder: string = '#353a42';
  @StorageProp('themeText') themeText: string = '#e8e8e8';
  @StorageProp('themeMuted') themeMuted: string = '#a3a9b2';
  @StorageProp('themeSecondary') themeSecondary: string = '#b5bec9';
  @StorageProp('themeAccent') themeAccent: string = '#7ddf7d';
  @StorageProp('themeLink') themeLink: string = '#96b8e5';
  @StorageProp('themeWarning') themeWarning: string = '#e0c070';
  @State localEnabled: boolean = true;
  @State dndEnabled: boolean = false;

  aboutToAppear(): void {
    let ctx = getContext(this);
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

  toggleLocal(isOn: boolean): void {
    this.localEnabled = isOn;
    setBool(getContext(this), KEY_NOTIFICATIONS_LOCAL_ENABLED, isOn).catch((e: Error) => {
      // 忽略写失败
    });
  }

  toggleDnd(isOn: boolean): void {
    this.dndEnabled = isOn;
    setBool(getContext(this), KEY_NOTIFICATIONS_DND_ENABLED, isOn).catch((e: Error) => {
      // 忽略写失败
    });
  }

  build() {
    Column({ space: 10 }) {
      Row({ space: 10 }) {
        Text('‹')
          .fontSize(22)
          .fontColor(this.themeAccent)
          .width(32)
          .height(32)
          .textAlign(TextAlign.Center)
          .onClick(() => {
            router.back();
          })
        Text('通知')
          .fontSize(20)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.themeText)
          .layoutWeight(1)
      }
      .width('100%')
      .padding({ left: 10, right: 14, top: 10 })

      List({ space: 14 }) {
        // 本地通知开关
        ListItem() {
          Column({ space: 8 }) {
            Text('本地通知')
              .fontSize(12)
              .fontColor(this.themeMuted)
              .width('100%')
              .padding({ left: 4 })
            Row({ space: 10 }) {
              Column({ space: 3 }) {
                Text('启用本地通知')
                  .fontSize(15)
                  .fontColor(this.themeText)
                Text('会话事件与连接状态变化时在系统通知栏提醒')
                  .fontSize(11)
                  .fontColor(this.themeMuted)
              }
              .alignItems(HorizontalAlign.Start)
              .layoutWeight(1)

              Toggle({ type: ToggleType.Switch, isOn: this.localEnabled })
                .selectedColor('#2a6a5a')
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
            Text('免打扰')
              .fontSize(12)
              .fontColor(this.themeMuted)
              .width('100%')
              .padding({ left: 4 })
            Row({ space: 10 }) {
              Column({ space: 3 }) {
                Text('启用免打扰')
                  .fontSize(15)
                  .fontColor(this.themeText)
                Text('开启后暂停本地会话通知，关闭后恢复')
                  .fontSize(11)
                  .fontColor(this.themeMuted)
              }
              .alignItems(HorizontalAlign.Start)
              .layoutWeight(1)

              Toggle({ type: ToggleType.Switch, isOn: this.dndEnabled })
                .selectedColor('#2a6a5a')
                .onChange((isOn: boolean) => {
                  this.toggleDnd(isOn);
                })
            }
            .width('100%')
            .padding(14)
            .borderRadius(12)
            .backgroundColor(this.themeSurface)
            .border({ width: 1, color: this.themeBorder })

            Text('免打扰立即控制本机通知；不影响桌面端的通知配置。')
              .fontSize(11)
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
