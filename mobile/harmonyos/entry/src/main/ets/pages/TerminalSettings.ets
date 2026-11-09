import { uiText } from '../settings/NativeUi';
import { router } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { getNumber, setNumber, readPagePreferencesSync, writePagePreferenceSync, KEY_TERMINAL_TEXT_SCALE, TERMINAL_TEXT_SCALES } from '../settings/SettingsStore';
import { TERMINAL_SHORTCUTS, CustomShortcut, shortcutLabel, TerminalShortcut } from '../settings/TerminalShortcuts';
import { listHosts, HostMeta } from '../storage/HostStore';
import { SessionPhase } from '../transport/HostSession';
import { DesktopConnectionLease, retainDesktopConnection } from '../transport/DesktopConnections';
import { RpcSuccess } from '../transport/SpikeRpcClient';
import { projectSideRail, readWindowRegions, WindowRegion } from '../webshell/WindowRegions';
import terminalRail from '../vendor/terminal-rail.js';

interface HostFit { id: string; name: string; connected: boolean; ms: number | null; loaded: boolean; saving: boolean; }
interface FitConnection { lease: DesktopConnectionLease; unobserve: () => void; }
interface RestoreOption { label: string; ms: number | null; }
const RESTORE_OPTIONS: RestoreOption[] = [ { label: '保持手机尺寸', ms: null }, { label: '1 分钟后', ms: 60000 },
  { label: '5 分钟后', ms: 300000 }, { label: '30 分钟后', ms: 1800000 } ];

@Entry
@Component
struct TerminalSettings {
  @StorageProp('uiLocale') uiLocale: string = 'en';
  @StorageProp('themeBg') themeBg: string = '#0a0a0a';
  @StorageProp('themeSurface') themeSurface: string = '#171717';
  @StorageProp('themeBorder') themeBorder: string = 'rgba(255, 255, 255, 0.07)';
  @StorageProp('themeText') themeText: string = '#fafafa';
  @StorageProp('themeMuted') themeMuted: string = '#898989';
  @StorageProp('themeAccent') themeAccent: string = '#3276f2';
  @StorageProp('shellWindowRegions') @Watch('updateDirectionPad') windowRegions: string = '';
  @State terminalScale: number = 1;
  @State error: string = '';
  @State ordered: string[] = TERMINAL_SHORTCUTS.map((key: TerminalShortcut): string => key.id);
  @State visible: string[] = TERMINAL_SHORTCUTS.map((key: TerminalShortcut): string => key.id);
  @State directionPad: boolean = true;
  @State directionPadAvailable: boolean = false;
  @State custom: CustomShortcut[] = [];
  @State customLabel: string = '';
  @State customBytes: string = '';
  @State customEnter: boolean = false;
  @State editing: string = '';
  @State fits: HostFit[] = [];
  private sessions: Map<string, FitConnection> = new Map();
  private epoch = 0;
  private frame: WindowRegion = { x: 0, y: 0, width: 0, height: 0 };

  private updateDirectionPad(): void {
    this.directionPadAvailable = terminalRail.hasTerminalDirectionPadSpace(projectSideRail(readWindowRegions(this.windowRegions), this.frame));
  }

  onPageShow(): void { this.load(); }
  onPageHide(): void { this.stopSessions(); }
  aboutToDisappear(): void { this.stopSessions(); }

  private stopSessions(): void {
    this.epoch++;
    this.sessions.forEach((session: FitConnection): void => { session.unobserve(); session.lease.release(); });
    this.sessions.clear();
  }

  private load(): void {
    this.stopSessions(); let epoch = this.epoch;
    getNumber(getContext(this), KEY_TERMINAL_TEXT_SCALE).then((value: number): void => { if (epoch === this.epoch) { this.terminalScale = value; } });
    try {
      let stored = readPagePreferencesSync(getContext(this));
      let layout: ESObject = JSON.parse(stored.get('orca:terminal-accessory-layout') ?? 'null');
      if (layout && Array.isArray(layout.orderedBuiltInIds) && Array.isArray(layout.visibleBuiltInIds)) {
        let known = TERMINAL_SHORTCUTS.map((key: TerminalShortcut): string => key.id);
        let ordered: string[] = layout.orderedBuiltInIds.filter((id: ESObject): boolean => typeof id === 'string' && known.includes(id));
        this.ordered = Array.from(new Set(ordered.concat(known)));
        this.visible = layout.visibleBuiltInIds.filter((id: ESObject): boolean => typeof id === 'string' && known.includes(id));
        this.directionPad = layout.directionPadEnabled !== false;
      }
      let custom: ESObject = JSON.parse(stored.get('orca:custom-accessory-keys') ?? '[]');
      if (Array.isArray(custom)) {
        this.custom = custom.filter((key: ESObject): boolean => key && typeof key.id === 'string' && typeof key.label === 'string'
          && typeof key.bytes === 'string' && typeof key.enter === 'boolean').map((key: ESObject): CustomShortcut => {
            return { id: key.id, label: key.label, bytes: key.bytes, enter: key.enter, visible: key.visible !== false };
          });
      }
    } catch (e) { this.error = '无法读取终端设置'; }
    let context = getContext(this) as common.UIAbilityContext;
    listHosts(context).then((hosts: HostMeta[]): void => {
      if (epoch !== this.epoch) { return; }
      this.fits = hosts.map((host: HostMeta): HostFit =>
        ({ id: host.id, name: host.name, connected: false, ms: null, loaded: false, saving: false }));
      hosts.forEach((host: HostMeta): void => {
        let lease = retainDesktopConnection(context, host.id);
        let connection = lease.connection;
        let unobserve = connection.observe((phase: SessionPhase): void => {
          if (epoch !== this.epoch) { return; }
          this.updateFit(host.id, phase === 'connected', null, false, false);
          let client = connection.getClient();
          if (phase === 'connected' && client) {
            client.request('terminal.getAutoRestoreFit', null).then((response): void => {
              if (epoch !== this.epoch || connection.getClient() !== client || !(response instanceof RpcSuccess)) { return; }
              try { let value: ESObject = JSON.parse(response.result); this.updateFit(host.id, true, this.readFit(value), true, false); }
              catch (e) { this.error = '无法读取桌面终端恢复设置'; }
            }).catch(() => {});
          }
        });
        this.sessions.set(host.id, { lease: lease, unobserve: unobserve });
        connection.connect();
      });
    }).catch((): void => { if (epoch === this.epoch) { this.error = '无法读取已配对桌面'; } });
  }

  private readFit(value: ESObject): number | null {
    if (value === null) { return null; }
    if (typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).includes('ms')
      || (value.ms !== null && (!Number.isSafeInteger(value.ms) || value.ms < 0))) { throw new Error('Invalid terminal setting'); }
    return value.ms;
  }

  private updateFit(id: string, connected: boolean, ms: number | null, loaded: boolean, saving: boolean): void {
    this.fits = this.fits.map((row: HostFit): HostFit => row.id === id
      ? { id: row.id, name: row.name, connected: connected, ms: ms, loaded: loaded, saving: saving } : row);
  }

  private async saveFit(row: HostFit, ms: number | null): Promise<void> {
    let client = this.sessions.get(row.id)?.lease.connection.getClient(); if (!client || row.saving) { return; }
    let epoch = this.epoch; this.updateFit(row.id, true, row.ms, row.loaded, true); this.error = '';
    let response = await client.request('terminal.setAutoRestoreFit', JSON.stringify({ ms: ms }));
    if (epoch !== this.epoch || this.sessions.get(row.id)?.lease.connection.getClient() !== client) { return; }
    if (response instanceof RpcSuccess) {
      try {
        let value: ESObject = JSON.parse(response.result);
        if (value === null || !Object.keys(value).includes('ms')) {
          let read = await client.request('terminal.getAutoRestoreFit', null);
          if (!(read instanceof RpcSuccess)) { throw new Error('Unable to confirm terminal setting'); }
          value = JSON.parse(read.result);
        }
        if (epoch === this.epoch) { this.updateFit(row.id, true, this.readFit(value), true, false); }
      } catch (e) { this.error = '无法确认桌面终端设置，请重试'; this.updateFit(row.id, true, row.ms, row.loaded, false); }
    } else { this.error = '无法保存桌面终端设置，请重试'; this.updateFit(row.id, true, row.ms, row.loaded, false); }
  }

  private async saveScale(value: number): Promise<void> {
    try { await setNumber(getContext(this), KEY_TERMINAL_TEXT_SCALE, value); this.terminalScale = value; this.error = ''; }
    catch (e) { this.error = '无法保存字号，请重试'; }
  }

  private saveLayout(ordered: string[], visible: string[], directionPad: boolean): void {
    try {
      writePagePreferenceSync(getContext(this), 'orca:terminal-accessory-layout', JSON.stringify({ version: 2,
        orderedBuiltInIds: ordered, visibleBuiltInIds: visible, directionPadEnabled: directionPad }));
      this.ordered = ordered; this.visible = visible; this.directionPad = directionPad; this.error = '';
    } catch (e) { this.error = '无法保存快捷键，请重试'; }
  }

  private moveKey(id: string, delta: number): void {
    let ordered = this.ordered.slice(); let at = ordered.indexOf(id); let next = at + delta;
    if (next < 0 || next >= ordered.length) { return; }
    let displaced = ordered[next]; ordered[next] = id; ordered[at] = displaced;
    this.saveLayout(ordered, this.visible, this.directionPad);
  }

  private saveCustom(keys: CustomShortcut[]): void {
    try { writePagePreferenceSync(getContext(this), 'orca:custom-accessory-keys', JSON.stringify(keys)); this.custom = keys; this.error = ''; }
    catch (e) { this.error = '无法保存自定义快捷键，请重试'; }
  }

  private moveCustom(id: string, delta: number): void {
    let keys = this.custom.slice(); let at = keys.findIndex((item: CustomShortcut): boolean => item.id === id); let next = at + delta;
    if (at < 0 || next < 0 || next >= keys.length) { return; }
    let displaced = keys[next]; keys[next] = keys[at]; keys[at] = displaced; this.saveCustom(keys);
  }

  private editCustom(key: CustomShortcut): void {
    this.editing = key.id; this.customLabel = key.label; this.customBytes = key.bytes; this.customEnter = key.enter;
  }

  private addCustom(): void {
    if (this.customLabel.trim().length === 0 || this.customBytes.length === 0 || (this.editing.length === 0 && this.custom.length >= 32)) {
      this.error = '填写快捷键名称和内容（最多 32 项）'; return;
    }
    let editing = this.editing;
    let key: CustomShortcut = { id: editing || `custom-${Date.now()}`, label: this.customLabel.trim(), bytes: this.customBytes, enter: this.customEnter, visible: true };
    let keys = editing.length > 0 ? this.custom.map((item: CustomShortcut): CustomShortcut => item.id === editing
      ? { id: key.id, label: key.label, bytes: key.bytes, enter: key.enter, visible: item.visible } : item) : this.custom.concat([key]);
    this.saveCustom(keys);
    if (this.error.length === 0) { this.customLabel = ''; this.customBytes = ''; this.customEnter = false; this.editing = ''; }
  }

  @Builder
  private sectionTitle(title: string) { Text(title).fontFamily('Geist').fontSize(11).fontWeight(FontWeight.Medium).fontColor(this.themeMuted).width('100%').padding({ top: 16, bottom: 8 }); }

  build() {
    Column() {
      Row() {
        Button('‹').fontFamily('Geist').fontSize(24).fontColor(this.themeText).backgroundColor(Color.Transparent).width(44).height(44).accessibilityText('返回').onClick((): void => { router.back(); })
        Text(uiText('终端', this.uiLocale)).fontFamily('Geist').fontSize(20).fontWeight(FontWeight.Medium).fontColor(this.themeText).layoutWeight(1)
      }.width('100%').padding({ top: 8, right: 16 })
      Scroll() {
        Column() {
          if (this.error.length > 0) { Text(this.error).fontFamily('Geist').fontSize(13).fontColor(this.themeText).width('100%').padding(12).backgroundColor(this.themeSurface) }
          this.sectionTitle('离开应用后')
          if (this.fits.length === 0) { Text(uiText('配对桌面后可设置终端恢复尺寸', this.uiLocale)).fontFamily('Geist').fontSize(14).fontColor(this.themeMuted).width('100%').padding(16) }
          ForEach(this.fits, (row: HostFit) => {
            Column({ space: 8 }) {
              Text(row.name).fontFamily('Geist').fontSize(14).fontColor(this.themeText).width('100%')
              if (!row.loaded) { Text(row.connected ? '正在读取…' : '等待桌面连接').fontFamily('Geist').fontSize(12).fontColor(this.themeMuted).width('100%') }
              ForEach(RESTORE_OPTIONS, (option: RestoreOption) => {
                Row() {
                  Text(option.label).fontFamily('Geist').fontSize(14).fontColor(this.themeText).layoutWeight(1)
                  if (row.loaded && option.ms === row.ms) { Text('✓').fontColor(this.themeAccent) }
                }.width('100%').height(44).enabled(row.connected && row.loaded && !row.saving)
                .opacity(row.connected && row.loaded && !row.saving ? 1 : 0.5).onClick((): void => { this.saveFit(row, option.ms); })
              })
            }.width('100%').padding(16).backgroundColor(this.themeSurface).borderRadius(12).margin({ bottom: 8 })
          }, (row: HostFit): string => row.id)
          Text(uiText('手机使用终端时会调整列宽。离开应用后，可保持手机尺寸或在指定时间后恢复桌面尺寸。', this.uiLocale)).fontFamily('Geist').fontSize(12).fontColor(this.themeMuted).width('100%').padding({ top: 8 })
          this.sectionTitle('文字大小')
          Column() {
            ForEach(TERMINAL_TEXT_SCALES, (scale: number) => {
              Row() { Text(`${Math.round(scale * 100)}%`).fontFamily('Geist').fontSize(14).fontColor(this.themeText).layoutWeight(1)
                if (scale === this.terminalScale) { Text('✓').fontColor(this.themeAccent) }
              }.width('100%').height(44).padding({ left: 16, right: 16 }).onClick((): void => { this.saveScale(scale); })
            })
          }.width('100%').backgroundColor(this.themeSurface).borderRadius(12)
          if (this.directionPadAvailable) {
            this.sectionTitle('方向键盘')
            Row({ space: 12 }) {
              Column({ space: 4 }) {
                Text(uiText('显示方向键盘', this.uiLocale)).fontFamily('Geist').fontSize(16).fontColor(this.themeText)
                Text(uiText('将方向键盘固定在侧栏。关闭后，侧栏会列出各个方向键。', this.uiLocale))
                  .fontFamily('Geist').fontSize(13).fontColor(this.themeMuted)
              }.alignItems(HorizontalAlign.Start).layoutWeight(1)
              Toggle({ type: ToggleType.Switch, isOn: this.directionPad }).selectedColor(this.themeAccent)
                .accessibilityText(uiText('显示方向键盘', this.uiLocale)).id('terminal-direction-pad-setting')
                .onChange((on: boolean): void => { this.saveLayout(this.ordered, this.visible, on); })
            }.width('100%').padding(16).backgroundColor(this.themeSurface).borderRadius(16)
          }
          this.sectionTitle('快捷键 · 拖动或使用箭头调整顺序')
          Column() {
            ForEach(this.ordered, (id: string) => {
              Row({ space: 8 }) {
                Text(shortcutLabel(id)).fontFamily('Geist').fontSize(14).fontColor(this.themeText).layoutWeight(1)
                Button('↑').width(44).height(44).backgroundColor(Color.Transparent).fontColor(this.themeMuted).accessibilityText('上移').onClick((): void => { this.moveKey(id, -1); })
                Button('↓').width(44).height(44).backgroundColor(Color.Transparent).fontColor(this.themeMuted).accessibilityText('下移').onClick((): void => { this.moveKey(id, 1); })
                Toggle({ type: ToggleType.Switch, isOn: this.visible.includes(id) }).selectedColor(this.themeAccent).accessibilityText(`显示 ${shortcutLabel(id)}`)
                  .onChange((on: boolean): void => { this.saveLayout(this.ordered, on ? this.visible.concat([id]) : this.visible.filter((item: string): boolean => item !== id), this.directionPad); })
              }.width('100%').padding({ left: 16, right: 16 }).height(48)
              .gesture(PanGesture({ direction: PanDirection.Vertical }).onActionEnd((event: GestureEvent): void => { if (Math.abs(event.offsetY) >= 24) { this.moveKey(id, event.offsetY > 0 ? 1 : -1); } }))
            }, (id: string): string => id)
          }.width('100%').backgroundColor(this.themeSurface).borderRadius(12)
          this.sectionTitle('自定义快捷键')
          Column({ space: 8 }) {
            ForEach(this.custom, (key: CustomShortcut, index: number) => {
              Row() {
                Column() { Text(key.label).fontFamily('Geist').fontSize(14).fontColor(this.themeText); Text(key.bytes).fontFamily('Geist').fontSize(12).fontColor(this.themeMuted).maxLines(1) }.alignItems(HorizontalAlign.Start).layoutWeight(1)
                Toggle({ type: ToggleType.Switch, isOn: key.visible }).selectedColor(this.themeAccent).onChange((on: boolean): void => {
                  this.saveCustom(this.custom.map((item: CustomShortcut): CustomShortcut => item.id === key.id ? { id: item.id, label: item.label, bytes: item.bytes, enter: item.enter, visible: on } : item));
                })
                Button(uiText('编辑', this.uiLocale)).fontColor(this.themeMuted).backgroundColor(Color.Transparent).height(44).onClick((): void => { this.editCustom(key); })
                Button(uiText('移除', this.uiLocale)).fontColor(this.themeMuted).backgroundColor(Color.Transparent).height(44).onClick((): void => { this.saveCustom(this.custom.filter((item: CustomShortcut): boolean => item.id !== key.id)); })
              }.width('100%').padding(8)
              Row() {
                Button('↑').fontColor(this.themeMuted).backgroundColor(Color.Transparent).width(44).height(44).onClick((): void => { this.moveCustom(key.id, -1); })
                Button('↓').fontColor(this.themeMuted).backgroundColor(Color.Transparent).width(44).height(44).onClick((): void => { this.moveCustom(key.id, 1); })
              }.width('100%')
              .gesture(PanGesture({ direction: PanDirection.Vertical }).onActionEnd((event: GestureEvent): void => { if (Math.abs(event.offsetY) >= 24) { this.moveCustom(key.id, event.offsetY > 0 ? 1 : -1); } }))
            }, (key: CustomShortcut): string => key.id)
            TextInput({ text: this.customLabel, placeholder: '名称' }).maxLength(64).onChange((value: string): void => { this.customLabel = value; })
            TextInput({ text: this.customBytes, placeholder: '发送到终端的内容' }).maxLength(1024).onChange((value: string): void => { this.customBytes = value; })
            Row() { Text(uiText('内容后发送回车', this.uiLocale)).fontFamily('Geist').fontSize(14).fontColor(this.themeText).layoutWeight(1)
              Toggle({ type: ToggleType.Switch, isOn: this.customEnter }).selectedColor(this.themeAccent).onChange((on: boolean): void => { this.customEnter = on; })
            }.width('100%').height(44)
            Button(this.editing.length > 0 ? '保存快捷键' : '添加快捷键').backgroundColor(this.themeAccent).fontColor('#ffffff').onClick((): void => { this.addCustom(); })
            if (this.editing.length > 0) { Button(uiText('取消编辑', this.uiLocale)).backgroundColor(Color.Transparent).fontColor(this.themeMuted).onClick((): void => { this.editing = ''; this.customLabel = ''; this.customBytes = ''; this.customEnter = false; }) }
          }.width('100%').padding(16).backgroundColor(this.themeSurface).borderRadius(12)
        }.width('100%').padding({ left: 16, right: 16, bottom: 24 })
      }.layoutWeight(1).width('100%')
    }.width('100%').height('100%').backgroundColor(this.themeBg)
      .onAreaChange((_previous: Area, area: Area): void => {
        this.frame = { x: Number(area.globalPosition.x), y: Number(area.globalPosition.y),
          width: Number(area.width), height: Number(area.height) };
        this.updateDirectionPad();
      })
  }
}
