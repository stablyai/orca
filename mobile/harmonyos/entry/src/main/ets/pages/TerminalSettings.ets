import { uiText } from '../settings/NativeUi';
import { common } from '@kit.AbilityKit';
import { lucideColorFilter } from '../settings/LucideColor';
import { SettingsNavBar } from '../settings/SettingsNavBar';
import { readPagePreferencesSync, writePagePreferenceSync, KEY_TERMINAL_TEXT_SCALE, TERMINAL_TEXT_SCALES } from '../settings/SettingsStore';
import { TerminalShortcutSettings } from '../settings/TerminalShortcutSettings';
import { listHosts, HostMeta } from '../storage/HostStore';
import { SessionPhase } from '../transport/HostSession';
import { DesktopConnectionLease, retainDesktopConnection } from '../transport/DesktopConnections';
import { RpcSuccess, SpikeRpcClient } from '../transport/SpikeRpcClient';
import { projectSideRail, readWindowRegions, WindowRegion } from '../webshell/WindowRegions';
import terminalRail from '../vendor/terminal-rail.js';

interface HostFit { id: string; name: string; connected: boolean; ms: number | null; loaded: boolean; saving: boolean; }
interface FitConnection { lease: DesktopConnectionLease; unobserve: (() => void) | null; revision: number; }
const RESTORE_OPTIONS: (number | null)[] = [null, 60_000, 300_000, 1_800_000];
const TEXT_SCALE_LABELS: string[] = ['smallestText', 'smallerText', 'defaultText', 'largeText', 'largerText', 'largestText'];

@Entry
@Component
struct TerminalSettings {
  @StorageProp('uiLocale') uiLocale: string = 'en';
  @StorageProp('themeBg') themeBg: string = '#0a0a0a';
  @StorageProp('themeSurface') themeSurface: string = '#171717';
  @StorageProp('themeSheet') themeSheet: string = '#171717';
  @StorageProp('themeRaised') themeRaised: string = '#262626';
  @StorageProp('themeBorder') themeBorder: string = 'rgba(255, 255, 255, 0.07)';
  @StorageProp('themeText') themeText: string = '#fafafa';
  @StorageProp('themeMuted') themeMuted: string = '#898989';
  @StorageProp('themeSecondary') themeSecondary: string = '#acacac';
  @StorageProp('themeScheme') themeScheme: string = 'dark';
  @StorageProp('shellWindowRegions') @Watch('updateDirectionPad') windowRegions: string = '';
  @State terminalScale: number = 1;
  @State pickerOpen: boolean = false;
  @State pickerHostId: string = '';
  @State error: string = '';
  @State directionPadAvailable: boolean = false;
  @State shortcutsRevision: number = 0;
  @State shortcutsCanScroll: boolean = true;
  @State viewportTop: number = 0;
  @State viewportBottom: number = 0;
  private settingsScroller: Scroller = new Scroller();
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
    this.pickerOpen = false;
    this.sessions.forEach((session: FitConnection): void => { session.unobserve?.(); session.lease.release(); });
    this.sessions.clear();
  }

  private load(): void {
    this.stopSessions();
    const epoch = this.epoch;
    this.error = '';
    this.shortcutsRevision++;
    const context = getContext(this) as common.UIAbilityContext;
    try {
      let stored = readPagePreferencesSync(context);
      this.terminalScale = Number(stored.get(KEY_TERMINAL_TEXT_SCALE) ?? '1');
    } catch (e) { this.error = '无法读取终端设置'; }
    listHosts(context).then((hosts: HostMeta[]): void => {
      if (epoch !== this.epoch) { return; }
      this.fits = hosts.map((host: HostMeta): HostFit =>
        ({ id: host.id, name: host.name, connected: false, ms: null, loaded: false, saving: false }));
      hosts.forEach((host: HostMeta): void => {
        let lease = retainDesktopConnection(context, host.id, 'automatic');
        let connection = lease.connection;
        const session: FitConnection = { lease: lease, unobserve: null, revision: 0 };
        this.sessions.set(host.id, session);
        let observedClient: SpikeRpcClient | null = null;
        session.unobserve = connection.observe((phase: SessionPhase): void => {
          if (epoch !== this.epoch) { return; }
          const client = phase === 'connected' ? connection.getClient() : null;
          if (observedClient === client) { return; }
          observedClient = client;
          const previous = this.fit(host.id);
          const loaded = previous?.loaded === true && !previous.saving;
          this.updateFit(host.id, client !== null, loaded ? previous.ms : null, loaded, false);
          const revision = ++session.revision;
          if (client) {
            this.loadFit(host.id, client, epoch, revision).catch(() => {});
          }
        });
      });
    }).catch((): void => { if (epoch === this.epoch) { this.error = this.t('hostsLoadFailed'); } });
  }

  private t(key: string): string {
    return uiText('app.terminalSettings.' + key, this.uiLocale);
  }

  private fit(id: string): HostFit | undefined {
    return this.fits.find((row: HostFit): boolean => row.id === id);
  }

  private isCurrentFitClient(id: string, client: SpikeRpcClient, epoch: number): boolean {
    return epoch === this.epoch && this.sessions.get(id)?.lease.connection.getClient() === client;
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

  private async requestFit(client: SpikeRpcClient): Promise<number | null> {
    const response = await client.request('terminal.getAutoRestoreFit', null);
    if (!(response instanceof RpcSuccess)) { throw new Error('Unable to read terminal setting'); }
    return this.readFit(JSON.parse(response.result));
  }

  private async loadFit(id: string, client: SpikeRpcClient, epoch: number, revision: number): Promise<void> {
    try {
      const ms = await this.requestFit(client);
      if (this.sessions.get(id)?.revision === revision && this.isCurrentFitClient(id, client, epoch)) {
        this.updateFit(id, true, ms, true, false);
      }
    } catch (e) {
      if (this.sessions.get(id)?.revision === revision && this.isCurrentFitClient(id, client, epoch)) {
        this.error = this.t('restoreLoadFailed');
      }
    }
  }

  private async saveFit(id: string, ms: number | null): Promise<void> {
    this.pickerOpen = false;
    const row = this.fit(id);
    const session = this.sessions.get(id);
    const client = session?.lease.connection.getClient();
    if (!session || !client || !row?.connected || row.saving) { return; }
    const epoch = this.epoch;
    session.revision++;
    this.error = '';
    this.updateFit(id, true, ms, true, true);
    let confirmed = row.ms;
    let loaded = row.loaded;
    try {
      const response = await client.request('terminal.setAutoRestoreFit', JSON.stringify({ ms: ms }));
      if (!this.isCurrentFitClient(id, client, epoch)) { return; }
      if (!(response instanceof RpcSuccess)) { throw new Error('Unable to save terminal setting'); }
      const value: ESObject = JSON.parse(response.result);
      confirmed = value === null || !Object.keys(value).includes('ms') ? await this.requestFit(client) : this.readFit(value);
      loaded = true;
    } catch (e) {
      if (!this.isCurrentFitClient(id, client, epoch)) { return; }
      this.error = this.t('restoreSaveFailed');
      try {
        confirmed = await this.requestFit(client);
        loaded = true;
      } catch (e) {}
    }
    if (this.isCurrentFitClient(id, client, epoch)) { this.updateFit(id, true, confirmed, loaded, false); }
  }

  private saveScale(value: number): void {
    this.pickerOpen = false;
    this.error = '';
    try {
      writePagePreferenceSync(getContext(this), KEY_TERMINAL_TEXT_SCALE, String(value));
      this.terminalScale = value;
    } catch (e) {
      this.error = this.t('scaleSaveFailed');
    }
  }

  private restoreLabel(ms: number | null | undefined): string {
    if (ms === undefined) { return '…'; }
    if (ms === null) { return this.t('keepPhoneSize'); }
    const preset = RESTORE_OPTIONS.includes(ms);
    const count = Math.round(ms / (preset ? 60_000 : 1000));
    const unit = preset ? 'Minutes' : 'Seconds';
    return this.t('restoreAfter' + unit + (count === 1 ? '_one' : '_other')).replace('{{count}}', String(count));
  }

  private selectedRestoreOption(): number | null {
    const ms = this.fit(this.pickerHostId)?.ms;
    if (ms === null || ms === undefined) { return null; }
    return RESTORE_OPTIONS.reduce((closest: number, option: number | null): number =>
      option !== null && Math.abs(option - ms) < Math.abs(closest - ms) ? option : closest, 60_000);
  }

  private scaleLabel(scale: number): string {
    return this.t(TEXT_SCALE_LABELS[TERMINAL_TEXT_SCALES.indexOf(scale)] ?? 'defaultText');
  }

  @Builder
  private settingsHeading(title: string, top: number) {
    Text(title).fontFamily('Geist').fontSize(13).fontWeight(FontWeight.Medium).fontColor(this.themeSecondary)
      .width('100%').padding({ left: 16, right: 16, top: top, bottom: 6 })
  }

  @Builder
  private settingsFooter(text: string) {
    Text(text).fontFamily('Geist').fontSize(13).lineHeight(18).fontColor(this.themeSecondary)
      .width('100%').padding({ left: 16, right: 16, top: 8 })
  }

  @Builder
  private settingsRow(icon: Resource, title: string, host: HostFit | null) {
    Row({ space: 12 }) {
      Image(icon).supportSvg2(true).width(18).height(18).colorFilter(lucideColorFilter(this.themeSecondary))
      Column({ space: 2 }) {
        Text(title).fontFamily('Geist').fontSize(15).fontWeight(FontWeight.Medium).fontColor(this.themeText)
        Text(host ? this.restoreLabel(host.loaded ? host.ms : undefined) : this.scaleLabel(this.terminalScale))
          .fontFamily('Geist').fontSize(13).fontColor(this.themeSecondary)
      }.alignItems(HorizontalAlign.Start).layoutWeight(1)
      Image($r('app.media.lucide_chevron_right')).supportSvg2(true).width(15).height(15)
        .colorFilter(lucideColorFilter(this.themeMuted))
    }.width('100%').padding({ left: 16, right: 16, top: 8, bottom: 8 })
  }

  @Builder
  private restoreRow(host: HostFit) {
    Button({ type: ButtonType.Normal }) {
      this.settingsRow($r('app.media.lucide_smartphone'), host.name, host)
    }.width('100%').constraintSize({ minHeight: 60 }).backgroundColor(Color.Transparent)
      .enabled(host.connected && !host.saving).opacity(host.connected ? 1 : 0.5)
      .onClick((): void => { this.pickerHostId = host.id; this.pickerOpen = true; })
  }

  @Builder
  private pickerOption(value: number | null, restore: boolean) {
    Button({ type: ButtonType.Normal }) {
      Row({ space: 12 }) {
        Text(restore ? this.restoreLabel(value) : this.scaleLabel(value ?? 1))
          .fontFamily('Geist').fontSize(15).fontWeight(FontWeight.Medium).fontColor(this.themeText).layoutWeight(1)
        if (restore ? this.selectedRestoreOption() === value : this.terminalScale === value) {
          Image($r('app.media.lucide_check')).supportSvg2(true).width(17).height(17)
            .colorFilter(lucideColorFilter(this.themeText))
        }
      }.width('100%').padding({ left: 16, right: 16, top: 8, bottom: 8 })
    }.width('100%').constraintSize({ minHeight: 48 }).backgroundColor(Color.Transparent)
      .accessibilitySelected(restore ? this.selectedRestoreOption() === value : this.terminalScale === value)
      .enabled(!restore || this.fit(this.pickerHostId)?.connected === true)
      .onClick((): void => {
        if (restore) { this.saveFit(this.pickerHostId, value).catch(() => {}); }
        else if (value !== null) { this.saveScale(value); }
      })
  }

  @Builder
  private picker() {
    Column({ space: 8 }) {
      Text(this.pickerHostId
        ? this.t('restoreHost').replace('{{name}}', (): string => this.fit(this.pickerHostId)?.name ?? '')
        : this.t('textSizePickerTitle'))
        .fontFamily('Geist').fontSize(13).fontWeight(FontWeight.Medium).fontColor(this.themeSecondary)
        .width('100%').padding({ left: 16, right: 16 })
      Column() {
        if (this.pickerHostId) {
          ForEach(RESTORE_OPTIONS, (ms: number | null, index: number) => {
            if (index > 0) { Divider().strokeWidth(0.5).color(this.themeBorder).margin({ left: 16 }) }
            this.pickerOption(ms, true)
          }, (ms: number | null): string => String(ms))
        } else {
          ForEach(TERMINAL_TEXT_SCALES, (scale: number, index: number) => {
            if (index > 0) { Divider().strokeWidth(0.5).color(this.themeBorder).margin({ left: 16 }) }
            this.pickerOption(scale, false)
          }, (scale: number): string => String(scale))
        }
      }.width('100%').borderRadius(16).clip(true)
        .backgroundColor(this.themeScheme === 'light' ? this.themeBg : this.themeRaised)
    }.width('100%').padding({ left: 16, right: 16, top: 14, bottom: 24 })
  }

  build() {
    Column() {
      SettingsNavBar({ title: this.t('title') })
      Scroll(this.settingsScroller) {
        Column() {
          if (this.error.length > 0) { Text(this.error).fontFamily('Geist').fontSize(13).fontColor(this.themeText).width('100%').padding(12).backgroundColor(this.themeSurface) }
          this.settingsHeading(this.t('leaveAppHeading'), 0)
          Column() {
            if (this.fits.length === 0) {
              Text(this.t('noPairedDesktops')).fontFamily('Geist').fontSize(13).fontColor(this.themeMuted)
                .width('100%').padding(16)
            } else {
              ForEach(this.fits, (row: HostFit, index: number) => {
                if (index > 0) { Divider().strokeWidth(0.5).color(this.themeBorder).margin({ left: 46 }) }
                this.restoreRow(row)
              }, (row: HostFit): string => JSON.stringify(row))
            }
          }.width('100%').backgroundColor(this.themeSurface).borderRadius(16).clip(true)
          this.settingsFooter(this.t('leaveAppDescription'))
          this.settingsHeading(this.t('textSizeHeading'), 16)
          Button({ type: ButtonType.Normal }) {
            this.settingsRow($r('app.media.lucide_type'), this.t('textSize'), null)
          }.width('100%').constraintSize({ minHeight: 60 }).backgroundColor(this.themeSurface).borderRadius(16)
            .onClick((): void => { this.pickerHostId = ''; this.pickerOpen = true; })
          this.settingsFooter(this.t('textSizeDescription'))
          TerminalShortcutSettings({ directionPadAvailable: this.directionPadAvailable,
            settingsRevision: this.shortcutsRevision, scrollingEnabled: $shortcutsCanScroll,
            scroller: this.settingsScroller, viewportTop: this.viewportTop, viewportBottom: this.viewportBottom })
        }.width('100%').padding({ left: 16, right: 16, top: 8, bottom: 24 })
      }.layoutWeight(1).width('100%').scrollBar(BarState.Off).align(Alignment.Top)
        .enableScrollInteraction(this.shortcutsCanScroll)
        .onAreaChange((_previous: Area, area: Area): void => {
          this.viewportTop = Number(area.globalPosition.y);
          this.viewportBottom = this.viewportTop + Number(area.height);
        })
    }.width('100%').height('100%').backgroundColor(this.themeBg)
      .bindSheet(this.pickerOpen, this.picker, { height: SheetSize.FIT_CONTENT, backgroundColor: this.themeSheet,
        maskColor: 'rgba(0,0,0,0.55)', showClose: false, onDisappear: (): void => { this.pickerOpen = false; } })
      .onAreaChange((_previous: Area, area: Area): void => {
        this.frame = { x: Number(area.globalPosition.x), y: Number(area.globalPosition.y),
          width: Number(area.width), height: Number(area.height) };
        this.updateDirectionPad();
      })
  }
}
