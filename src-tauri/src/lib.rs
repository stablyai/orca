use tauri::Manager;

const DEFAULT_DEV_HOST_URL: &str = "http://127.0.0.1:6769";

#[tauri::command]
fn desktop_host_url() -> String {
  std::env::var("ORCA_DESKTOP_HOST_URL").unwrap_or_else(|_| DEFAULT_DEV_HOST_URL.to_string())
}

#[tauri::command]
fn desktop_runtime_kind() -> &'static str {
  "tauri-pake"
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title("Orca");
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![desktop_host_url, desktop_runtime_kind])
    .run(tauri::generate_context!())
    .expect("error while running the Orca Tauri desktop host");
}
